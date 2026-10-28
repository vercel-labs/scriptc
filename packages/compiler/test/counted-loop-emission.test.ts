import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

test("counted loops guard exact induction and preserve wide remainders on both pointer widths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-counted-loops-"));
  try {
    const entry = join(import.meta.dirname, "../../../tests/corpus/counted-loop-numbers.ts");
    const outPath = join(dir, "numbers.ir.json");
    const result = await compile(entry, { outPath, outDir: dir, outputKind: "ir" });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    const body = (ll: string, name: string): string =>
      ll.match(
        new RegExp(
          `define internal [^\\n]+ @sc_f_${name}(?:\\.i32)?\\([^\\n]*\\) #0 \\{([\\s\\S]*?)\\n\\}`,
        ),
      )![1]!;
    for (const pointerBits of [32, 64] as const) {
      const ll = emitLlvmModule(mod, { pointerBits, wasi: pointerBits === 32 });
      const exclusive = body(ll, "exclusive");
      expect(exclusive).toContain("counted.fast");
      expect(exclusive).toContain("counted.slow");
      expect(exclusive).toContain("fcmp ole double");
      expect(exclusive).toContain("alloca i64 ; integer induction i");
      const fast = exclusive.slice(exclusive.indexOf("\ncounted.fast"));
      expect(fast).toContain("urem i64");
      expect(fast).not.toContain("uint32.coerce");
      expect(body(ll, "inclusive")).toContain("fcmp ole double");
      expect(body(ll, "inclusive")).toContain("0x433FFFFFFFFFFFFF");
      expect(body(ll, "wide")).toMatch(/urem i64 %\w+, 4294967297/);
      for (const name of ["changed", "captured"])
        expect(body(ll, name)).not.toContain("counted.fast");
      expect(body(ll, "remainders")).toContain("frem double");
    }
    const debug = emitLlvmModule(mod, {
      debugSources: new Map([[entry, await readFile(entry, "utf8")]]),
    });
    expect(debug).not.toContain("counted.fast");
    expect(debug).toContain("@llvm.dbg.declare");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("worker programs poll counted loops over typed arrays between blocks of iterations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-counted-poll-"));
  try {
    const source = (workers: boolean): string =>
      [
        workers ? 'import { isMainThread, Worker } from "node:worker_threads";' : "",
        "export function scale(a: Float64Array, b: Float64Array, n: number): void {",
        "  for (let i = 0; i < n; i++) b[i] = a[i]! * 2;",
        "}",
        "export function codes(a: Uint8Array): void {",
        "  for (let i = 0; i < a.length; ++i) a[i] = a[i] === 97 ? 0 : 3;",
        "}",
        "export function shrink(a: Uint8Array): number {",
        "  let t = 0;",
        "  for (let i = 0; i < a.length; ++i) {",
        "    t += a[i]!;",
        "    if (i === 2) a = a.subarray(0, 3);",
        "  }",
        "  return t;",
        "}",
        "export function mix(n: number): number {",
        "  let t = 0;",
        "  for (let i = 0; i < n; i++) t = (t * 31 + i) % 1000003;",
        "  return t;",
        "}",
        "const a = new Float64Array(8).fill(1);",
        "const b = new Float64Array(8);",
        "scale(a, b, 8);",
        "const c = new Uint8Array(8).fill(97);",
        "codes(c);",
        "console.log(b[7], mix(8), c[0], shrink(new Uint8Array(8).fill(1)));",
        workers ? "if (!isMainThread) new Worker(new URL(import.meta.url));" : "",
      ].join("\n");
    const emit = async (workers: boolean): Promise<string> => {
      const entry = join(dir, `${workers ? "worker" : "plain"}.ts`);
      await writeFile(entry, source(workers));
      const outPath = join(dir, `${workers ? "worker" : "plain"}.ir.json`);
      const result = await compile(entry, { outPath, outDir: dir, outputKind: "ir" });
      if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
      return emitLlvmModule(deserializeModule(await readFile(outPath, "utf8")));
    };
    // Every emitted version of a function (the number and int32 entries).
    const bodies = (ll: string, name: string): string =>
      [
        ...ll.matchAll(
          new RegExp(
            `define internal [^\\n]+ @sc_b?f_${name}(?:\\.i32)?\\([^\\n]*\\n([\\s\\S]*?)\\n\\}`,
            "g",
          ),
        ),
      ]
        .map((match) => match[1]!)
        .join("\n");
    const workerModule = await emit(true);
    const worker = bodies(workerModule, "scale");
    const blocks = worker.split(/\n(?=[\w.]+:)/);
    // No budget in the body: the inner loop's latch only steps the counter,
    // the poll runs after each block, and the block's bound is the nearer of
    // the limit and 64 steps on.
    expect(worker).not.toContain("worker cancellation budget");
    expect(worker).toContain("@llvm.sadd.sat.i64(i64 %");
    expect(worker).toMatch(/@llvm\.smin\.i64\(i64 %\w+, i64 %\w+\)/);
    for (const latch of blocks.filter((block) => block.startsWith("loop.u")))
      expect(latch).not.toContain("scr_exc_flag");
    const polls = blocks.filter((block) => block.startsWith("loop.poll"));
    expect(polls.length).toBeGreaterThan(0);
    for (const poll of polls) expect(poll).toContain("@scr_exc_flag");
    // A counted loop without typed-array accesses keeps the budget.
    // A loop to a typed array's length is strip-mined the same way, with the
    // length as each block's limit.
    const codes = bodies(workerModule, "codes");
    expect(codes).not.toContain("worker cancellation budget");
    expect(codes).toMatch(/@llvm\.uadd\.sat\.i64\(i64 %\w+, i64 64\)/);
    expect(codes).toMatch(/@llvm\.umin\.i64\(i64 %\w+, i64 %\w+\)/);
    expect(codes).toMatch(/^loop\.poll\d+:$/m);
    // A loop that assigns its array reads the new length on the next
    // iteration: it keeps the budget.
    const shrink = bodies(workerModule, "shrink");
    expect(shrink).toContain("worker cancellation budget");
    expect(shrink).not.toMatch(/^loop\.poll\d+:$/m);
    const mix = bodies(workerModule, "mix");
    expect(mix).toContain("worker cancellation budget");
    expect(mix).not.toContain("loop.poll");
    const plain = bodies(await emit(false), "scale");
    expect(plain).not.toContain("loop.poll");
    expect(plain).not.toContain("@scr_exc_flag");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ELF worker executables poll the loops of a nest on every iteration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-nest-poll-"));
  try {
    const entry = join(dir, "nest.ts");
    await writeFile(
      entry,
      [
        'import { isMainThread, Worker } from "node:worker_threads";',
        "export function steps(limit: number): number {",
        "  let total = 0;",
        "  for (let start = 1; start < limit; start++) {",
        "    let x = start;",
        "    while (x !== 1) {",
        "      x = x % 2 === 0 ? x / 2 : 3 * x + 1;",
        "      total++;",
        "    }",
        "  }",
        "  return total;",
        "}",
        "export function mix(n: number): number {",
        "  let t = 0;",
        "  for (let i = 0; i < n; i++) t = (t * 31 + i) % 1000003;",
        "  return t;",
        "}",
        "console.log(steps(8), mix(8));",
        "if (!isMainThread) new Worker(new URL(import.meta.url));",
      ].join("\n"),
    );
    const outPath = join(dir, "nest.ir.json");
    const result = await compile(entry, { outPath, outDir: dir, outputKind: "ir" });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    const body = (ll: string, name: string): string =>
      ll.match(
        new RegExp(
          `define internal [^\\n]+ @sc_b?f_${name}(?:\\.i32)?\\([^\\n]*\\n([\\s\\S]*?)\\n\\}`,
        ),
      )![1]!;
    // Both loops of the nest test the thread's pending word on every
    // iteration and keep no countdown; a loop on its own keeps one.
    const elf = emitLlvmModule(mod, { targetTriple: "x86_64-unknown-linux-gnu" });
    const steps = body(elf, "steps");
    expect(steps).not.toContain("worker cancellation budget");
    expect(steps.match(/= load atomic i32, ptr @scr_exc_flag monotonic/g)?.length).toBe(2);
    expect(body(elf, "mix")).toContain("worker cancellation budget");
    // Elsewhere the poll reads the process-wide alert word: the nest counts.
    const darwin = emitLlvmModule(mod, { targetTriple: "arm64-apple-macosx14.0.0" });
    expect(body(darwin, "steps").match(/worker cancellation budget/g)?.length).toBe(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("worker programs poll no loop whose proven ranges bound its runs inside another loop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-bounded-loop-polls-"));
  try {
    const entry = join(dir, "bounded.ts");
    await writeFile(
      entry,
      [
        'import { isMainThread, Worker } from "node:worker_threads";',
        "const LIMIT = 50;",
        "export function rows(cr: Float64Array, n: number): number {",
        "  let t = 0;",
        "  for (let r = 0; r < n; r++)",
        "    for (let i = 0; i < 8; i += 2) {",
        "      const c = cr[i]!;",
        "      for (let j = 0; j < LIMIT; j++) {",
        "        t = (t * 31 + j + c) % 1000003;",
        "        if (t === 7) break;",
        "      }",
        "    }",
        "  return t;",
        "}",
        "export function open(cr: Float64Array, n: number, k: number): number {",
        "  let t = 0;",
        "  for (let r = 0; r < n; r++)",
        "    for (let i = 0; i < 8; i += 2) {",
        "      const c = cr[i]!;",
        "      for (let j = 0; j < k; j++) {",
        "        t = (t * 31 + j + c) % 1000003;",
        "        if (t === 7) break;",
        "      }",
        "    }",
        "  return t;",
        "}",
        "export function wide(n: number): number {",
        "  let t = 0;",
        "  for (let r = 0; r < n; r++) for (let j = 0; j < 5000; j++) t = (t * 31 + j) % 1000003;",
        "  return t;",
        "}",
        "export function exact(n: number): number {",
        "  let t = 0;",
        "  for (let r = 0; r < n; r++)",
        "    for (let j = 9007199254740900; j < 9007199254740950; j++) t = (t + (j % 7)) % 1000003;",
        "  return t;",
        "}",
        "export function stalled(n: number): number {",
        "  let t = 0;",
        "  for (let r = 0; r < n; r++)",
        "    for (let j = 9007199254740990; j < 9007199254741002; j++) t = (t + (j % 7)) % 1000003;",
        "  return t;",
        "}",
        "export function single(): number {",
        "  let t = 0;",
        "  for (let j = 0; j < 50; j++) t = (t * 31 + j) % 1000003;",
        "  return t;",
        "}",
        "const cr = new Float64Array(8).fill(0.5);",
        'const k = Number(process.argv[2] ?? "50");',
        "console.log(rows(cr, 3), open(cr, 3, k), wide(2), exact(2), stalled(0), single());",
        "if (!isMainThread) new Worker(new URL(import.meta.url));",
      ].join("\n"),
    );
    const outPath = join(dir, "bounded.ir.json");
    const result = await compile(entry, { outPath, outDir: dir, outputKind: "ir" });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    const ll = emitLlvmModule(deserializeModule(await readFile(outPath, "utf8")));
    const body = (name: string): string =>
      [
        ...ll.matchAll(
          new RegExp(
            `define internal [^\\n]+ @sc_b?f_${name}(?:\\.i32)?\\([^\\n]*\\n([\\s\\S]*?)\\n\\}`,
            "g",
          ),
        ),
      ]
        .map((match) => match[1]!)
        .join("\n");
    const polls = (text: string): number => text.match(/@scr_exc_flag/g)?.length ?? 0;
    // The i and j loops of `rows` run at most 4 × (1 + 50) bodies: only the
    // r loop polls, and the i loop over the typed array is not strip-mined.
    const rows = body("rows");
    expect(rows).not.toMatch(/^loop\.poll\d+:$/m);
    expect(polls(rows)).toBeGreaterThan(0);
    // With a limit known only at run time the inner loops keep their polls.
    // The innermost one is strip-mined, and a block that ends at the limit
    // leaves it without polling: only a block that ends short of it polls.
    const open = body("open");
    expect(polls(open)).toBeGreaterThan(polls(rows));
    expect(open).toMatch(/^loop\.poll\d+:$/m);
    const ends = [...open.matchAll(/^loop\.end\d+:$[\s\S]*?^\S/gm)].map((match) => match[0]);
    expect(ends.length).toBeGreaterThan(0);
    for (const end of ends) expect(end).toMatch(/br i1 %\w+, label %loop\.poll\d+, label %/);
    // A run of up to 16384 iterations is one block, polled as it leaves when
    // it took more than 64.
    expect(open).toMatch(/^loop\.poll\.run\d+:$/m);
    // Steps of 1 below 2^53 are exact, so 50 runs near it are bounded. From
    // 2^53, `j + 1 === j`: a counter ranging up to it can run without end
    // and keeps its poll.
    expect(polls(body("exact"))).toBe(polls(body("single")));
    expect(polls(body("stalled"))).toBeGreaterThan(polls(body("exact")));
    // A nest over the bound, or a loop no other loop encloses, polls.
    expect(polls(body("wide"))).toBeGreaterThan(0);
    expect(body("wide")).toMatch(/^loop\.poll\d+:$/m);
    expect(polls(body("single"))).toBeGreaterThan(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("worker programs read and write shared elements at a strip-mined loop's counter with plain accesses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-counted-shared-"));
  try {
    const entry = join(dir, "shared.ts");
    await writeFile(
      entry,
      [
        'import { isMainThread, Worker } from "node:worker_threads";',
        "export function scale(a: Float64Array, b: Float64Array, n: number): void {",
        "  for (let i = 0; i < n; i++) b[i] = a[i]! * 2;",
        "}",
        "export function codes(a: Uint8Array): void {",
        "  for (let i = 0; i < a.length; ++i) a[i] = a[i] === 97 ? 0 : 3;",
        "}",
        "export function shift(a: Uint8Array): void {",
        "  for (let i = 0; i < a.length - 1; i++) a[i] = a[i + 1]!;",
        "}",
        "export function rows(a: Int32Array, n: number): number {",
        "  let t = 0;",
        "  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) t += a[i]! + a[j]!;",
        "  return t;",
        "}",
        "export function waits(a: Int32Array, out: Uint8Array, n: number): number {",
        "  let spins = 0;",
        "  for (let i = 0; i < n; i++) {",
        "    out[i] = 1;",
        "    while (a[i] === 0) spins++;",
        "    do spins++; while (a[i] === 1);",
        "    for (let k = 0; a[i]! > k; k++) spins++;",
        "    for (let k = 0; k < 3; k += a[i]!) spins++;",
        "  }",
        "  return spins;",
        "}",
        "export function spin(a: Int32Array): number {",
        "  let n = 0;",
        "  while (a[0] === 0 && n < 10) n++;",
        "  return n;",
        "}",
        "const a = new Float64Array(new SharedArrayBuffer(64)).fill(1);",
        "const b = new Float64Array(8);",
        "scale(a, b, 8);",
        "const c = new Uint8Array(new SharedArrayBuffer(8)).fill(97);",
        "codes(c);",
        "shift(c);",
        "const d = new Int32Array(new SharedArrayBuffer(16)).fill(1);",
        "console.log(b[7], c[0], rows(d, 4), spin(d), waits(new Int32Array(new SharedArrayBuffer(16)).fill(2), new Uint8Array(new SharedArrayBuffer(4)), 4));",
        "if (!isMainThread) new Worker(new URL(import.meta.url));",
      ].join("\n"),
    );
    const outPath = join(dir, "shared.ir.json");
    const result = await compile(entry, { outPath, outDir: dir, outputKind: "ir" });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    const ll = emitLlvmModule(deserializeModule(await readFile(outPath, "utf8")));
    const bodies = (name: string): string =>
      [
        ...ll.matchAll(
          new RegExp(
            `define internal [^\\n]+ @sc_b?f_${name}(?:\\.i32)?\\([^\\n]*\\n([\\s\\S]*?)\\n\\}`,
            "g",
          ),
        ),
      ]
        .map((match) => match[1]!)
        .join("\n");
    // Element loads (the poll's flag read is atomic too, from a global).
    const elementLoads = (body: string): number =>
      body.match(/load atomic \w+, ptr %/g)?.length ?? 0;
    // Elements at the counter of a strip-mined loop: plain loads and stores.
    for (const name of ["scale", "codes"]) {
      const body = bodies(name);
      expect(body).toMatch(/^loop\.poll\d+:$/m);
      expect(elementLoads(body)).toBe(0);
      expect(body).not.toContain("store atomic");
    }
    // `a[i + 1]` is not at the counter: its read stays atomic, the store
    // at the counter is plain.
    const shift = bodies("shift");
    expect(shift).toMatch(/load atomic i8, ptr %/);
    expect(shift).not.toContain("store atomic");
    // The outer counter read inside the inner loop reads one element on every
    // inner iteration: it stays atomic; the inner counter's read is plain.
    const rows = bodies("rows");
    expect(rows).toMatch(/load atomic i32, ptr %/);
    // A loop that is not counted keeps atomic reads.
    expect(bodies("spin")).toMatch(/load atomic i32, ptr %/);
    // A nested loop that tests the outer counter's element in its condition
    // or steps by it reads it again on every iteration: each read stays
    // atomic, so another thread's write ends the wait.
    const waits = bodies("waits");
    expect(waits).toMatch(/^loop\.poll\d+:$/m);
    expect(waits.match(/load atomic i32, ptr %/g)?.length).toBeGreaterThanOrEqual(4);
    // The outer loop's write at its counter stays plain (speculation counters
    // are atomic stores to globals).
    expect(waits).not.toMatch(/store atomic i8 \S+, ptr %/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a loop that starts from a typed-array read guards the read's integer and ordered bit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-counted-reads-"));
  try {
    const entry = join(dir, "chain.ts");
    await writeFile(
      entry,
      [
        "export function chain(pp: Int32Array): number {",
        "  let p0 = pp[0]!;",
        "  let n = 0;",
        "  while (pp[p0] !== 0) {",
        "    n++;",
        "    for (let i = 1, j = p0 - 1; i < j; i++, j--) {",
        "      const t = pp[i]!;",
        "      pp[i] = pp[j]!;",
        "      pp[j] = t;",
        "    }",
        "    const t = pp[p0]!;",
        "    pp[p0] = p0;",
        "    p0 = t;",
        "  }",
        "  return n;",
        "}",
        "console.log(chain(Int32Array.from([3, 1, 2, 0])));",
      ].join("\n"),
    );
    const outPath = join(dir, "chain.ir.json");
    const result = await compile(entry, { outPath, outDir: dir, outputKind: "ir" });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    const ll = emitLlvmModule(deserializeModule(await readFile(outPath, "utf8")));
    const body = ll.match(/define internal double @sc_bf_chain\([^\n]*\n([\s\S]*?)\n\}/)![1]!;
    // `p0` holds a read's integer or NaN: it keeps whether it is NaN beside
    // its integer view, and `p0 - 1` starts the loop from that integer. No
    // test converts the double back to check it is an exact integer.
    expect(body).toContain("alloca i1 ; ordered view p0");
    expect(body).toContain("counted.fast");
    expect(body).not.toContain("bitcast double");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an exact integer loop limit becomes the endpoint without rounding", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-counted-limit-"));
  try {
    const entry = join(import.meta.dirname, "../../../tests/corpus/counted-loop-integer-limits.ts");
    const outPath = join(dir, "limits.ir.json");
    const result = await compile(entry, { outPath, outDir: dir, outputKind: "ir" });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    const ll = emitLlvmModule(deserializeModule(await readFile(outPath, "utf8")), {});
    const bodies = (method: string): string[] =>
      [
        ...ll.matchAll(
          new RegExp(
            `define internal [^\\n]+ @\\w*Page_${method}(?:\\.i32)?\\([^\\n]*\\) #0 \\{ ; [^\\n]*([\\s\\S]*?)\\n\\}`,
            "g",
          ),
        ),
      ].map((m) => m[1]!);
    // The int32 rank is the endpoint of the loops in both directions, with
    // exclusive and inclusive bounds: no floor, ceil or 2^53 clamp.
    for (const method of ["set", "suffix"]) {
      const found = bodies(method);
      expect(found.length).toBeGreaterThan(0);
      for (const body of found) {
        expect(body).toContain("integer induction i");
        expect(body).not.toMatch(/@llvm\.(floor|ceil)\.f64/);
        expect(body).not.toContain("0x4340000000000000");
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
