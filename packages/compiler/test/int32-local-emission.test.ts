import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

const repoRoot = join(import.meta.dirname, "../../..");

const source = `
import type { Int32 } from "@scriptc/types";
function rsync(a: Uint8Array): number {
  let s1 = 0,
    s2 = 0;
  for (let i = 0; i < a.length; i++) {
    s1 = (s1 + a[i]) & 0xffff;
    s2 = (s2 + s1) & 0xffff;
  }
  return ((s2 << 16) | s1) >>> 0;
}
function mix(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + i) | 0;
  return h;
}
function counters(): number {
  let up = 0;
  const before = up++;
  const after = ++up;
  let down = 3;
  const was = down--;
  return before * 1000 + after * 100 + was * 10 + down;
}
function unsigned(a: Uint32Array): number {
  let acc = 0;
  for (let i = 0; i < a.length; i++) acc = (acc + (a[i] ^ i)) >>> 0;
  return acc;
}
function fraction(n: number): number {
  let h = 0;
  for (let i = 0; i < n; i++) h = (h + i) | 0;
  h = h / 2;
  return h;
}
function mixed(n: number): number {
  let m = -1 | 0;
  if (n > 1) m = m >>> 0;
  return m;
}
function captured(words: string[]): number {
  let h = 17;
  const add = (w: string): void => {
    for (let i = 0; i < w.length; i++) h = (Math.imul(h, 31) + w.charCodeAt(i)) | 0;
  };
  for (const w of words) add(w);
  return h;
}
function capturedParam(seed: number): () => number {
  return () => seed;
}
function* frames(words: string[]): Generator<number> {
  let h = 0;
  for (const w of words) {
    for (let i = 0; i < w.length; i++) h = (Math.imul(h, 33) ^ w.charCodeAt(i)) | 0;
    yield h;
  }
}
async function suspended(words: string[]): Promise<number> {
  let total = 0;
  for (const w of words) {
    await Promise.resolve();
    total = (total + w.length) | 0;
  }
  return total;
}
function contract(seed: Int32, steps: Int32): Int32 {
  let acc: Int32 = seed;
  for (let i: Int32 = 0; i < steps; i = (i + 1) | 0) acc = (Math.imul(acc, 3) + i) | 0;
  return acc;
}
function fibo(n: number): number {
  return n < 2 ? n : fibo(n - 1) + fibo(n - 2);
}
function modular(times: number): number {
  let v = 7;
  for (let i = 0; i < times; i++) v = (v * 31 + 3) % 1000003;
  return v;
}
function strides(marks: Uint8Array): number {
  let count = 0;
  for (let i = 2; i <= 1000; i++) for (let j = i * 2; j <= 1000; j += i) count += marks[j & 3];
  return count;
}
const bytes = new Uint8Array([1, 2, 3, 250]);
console.log(modular(100), strides(bytes));
console.log(rsync(bytes), mix("abcd"), counters(), unsigned(new Uint32Array([4294967295, 7])));
console.log(fraction(5), mixed(3), captured(["ab", "c"]), capturedParam(3)());
console.log([...frames(["ab", "cd"])].join(" "), contract(7, 20), fibo(10));
suspended(["ab"]).then((t) => console.log(t));
`;

/** A function's body: its i32 entry when it has one (int32-abi.ts), not
 * the double-ABI wrapper around it. */
const body = (ll: string, name: string): string =>
  ll.match(
    new RegExp(
      `define internal [^\\n]+ @sc_(?:b)?f_${name}(?:\\.i32)?\\([^\\n]*\\) #0 \\{ ;([\\s\\S]*?)\\n\\}`,
    ),
  )![1]!;

/** Every function definition whose header or body matches. */
const functionsWith = (ll: string, pattern: RegExp): string[] =>
  ll.split(/^(?=define )/m).filter((fn) => fn.startsWith("define ") && pattern.test(fn));

/** The blocks of a function's first loop, from its header to its exit. */
const loopOf = (fn: string): string => {
  const start = fn.search(/\nloop\.c\d+:/);
  expect(start).toBeGreaterThan(0);
  const end = fn.indexOf("\nloop.e", start);
  return fn.slice(start, end < 0 ? undefined : end);
};

/** The function without pure instructions whose results nothing uses,
 * repeatedly, as LLVM's dead code elimination leaves it. */
const live = (fn: string): string => {
  const pure =
    /^\s*(%[\w.]+) = (?:[su]itofp|fpto[su]i|f(?:add|sub|mul|div|neg|cmp)|select|[sz]ext|trunc|add|sub|mul|and|or|xor|shl|lshr|ashr|icmp|phi|freeze|bitcast|getelementptr|load) /;
  let lines = fn.split("\n");
  for (let changed = true; changed;) {
    changed = false;
    const text = lines.join("\n");
    lines = lines.filter((line) => {
      const name = line.match(pure)?.[1];
      if (!name) return true;
      const uses = text.split(new RegExp(`${name.replace(/\./g, "\\.")}(?![\\w.])`)).length - 2;
      if (uses > 0) return true;
      changed = true;
      return false;
    });
  }
  return lines.join("\n");
};

/** What keeps a double carrier of a local in a function's loop once dead
 * values are gone: double loads and stores of local slots, and widened
 * reads of a local's i32. */
const carriers = (fn: string): string[] => {
  const loop = loopOf(live(fn));
  const reads = new Set(
    [...loop.matchAll(/^\s*(%[\w.]+) = load i32, ptr %sc_l_\w+$/gm)].map((m) => m[1]),
  );
  return [
    ...loop.matchAll(/^\s*(?:%[\w.]+ = load double, ptr|store double [^,]+, ptr) %sc_l_\w+$/gm),
    ...[...loop.matchAll(/^\s*%[\w.]+ = [su]itofp i32 (%[\w.]+) to double$/gm)].filter((m) =>
      reads.has(m[1]),
    ),
  ].map((m) => m[0].trim());
};

test("int32-closed locals are stored as i32 and keep doubles only for floating consumers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-int32-locals-"));
  try {
    await symlink(join(repoRoot, "node_modules"), join(dir, "node_modules"));
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    for (const pointerBits of [32, 64] as const) {
      const ll = emitLlvmModule(mod, { pointerBits, wasi: pointerBits === 32 });

      // Loop-carried accumulators and counters: i32 slots, no per-iteration
      // conversion to or from a double, no integer view beside them.
      const rsync = body(ll, "rsync");
      expect(rsync).toMatch(/alloca i32 ; s1\n/);
      expect(rsync).toMatch(/alloca i32 ; s2\n/);
      expect(rsync).not.toMatch(/alloca double ; s[12]\n/);
      expect(rsync).not.toContain("integer view");
      expect(carriers(rsync)).toEqual([]);
      const mix = body(ll, "mix");
      expect(mix).toMatch(/alloca i32 ; h\n/);
      expect(mix).toMatch(/alloca i32 ; i\n/);
      expect(carriers(mix)).toEqual([]);
      // The int32 result leaves through the i32 entry as the loaded i32.
      expect(mix).toMatch(
        / = load i32, ptr %sc_l_h_\w+\n(?:\s+%\w+ = sitofp [^\n]+\n)?\s+ret i32 %\w+/,
      );

      // ++ and -- write proven int32s in place.
      const counters = body(ll, "counters");
      expect(counters).toMatch(/alloca i32 ; up\n/);
      expect(counters).toMatch(/alloca i32 ; down\n/);
      expect(counters.match(/ = add i32 %\w+, 1\n/g)).toHaveLength(2);
      expect(counters).toMatch(/ = sub i32 %\w+, 1\n/);

      // A uint32 accumulator holds its bits and widens unsigned.
      const unsigned = body(ll, "unsigned");
      expect(unsigned).toMatch(/alloca i32 ; acc\n/);
      expect(carriers(unsigned)).toEqual([]);
      expect(unsigned).toMatch(/ = uitofp i32 %\w+ to double\n\s+ret double/);

      // A remainder of exact non-negative arithmetic closes the local in a
      // non-negative int32: 32-bit multiply, add and remainder, no checked
      // floating remainder.
      const modular = body(ll, "modular");
      expect(modular).toMatch(/alloca i32 ; v\n/);
      expect(carriers(modular)).toEqual([]);
      expect(loopOf(modular)).toMatch(/ = mul nsw i32 /);
      expect(loopOf(modular)).toMatch(/ = urem i32 /);
      expect(modular).not.toContain("frem");

      // A counter stepped by a loop-invariant positive int32 is one.
      const strides = body(ll, "strides");
      expect(strides).toMatch(/alloca i32 ; j\n/);
      expect(strides).not.toMatch(/alloca double ; j\n/);

      // Locals that leave int32, or hold both int32 and uint32 values.
      expect(body(ll, "fraction")).toMatch(/alloca double ; h\n/);
      expect(body(ll, "mixed")).toMatch(/alloca double ; m\n/);

      // Captured bindings keep their boxes, inside and outside the closure.
      const captured = body(ll, "captured");
      expect(captured).toMatch(/alloca ptr ; h\n/);
      expect(captured).not.toMatch(/alloca i32 ; h\n/);
      const closures = functionsWith(ll, /; captured h\n/);
      expect(closures.length).toBeGreaterThan(0);
      for (const fn of closures) expect(fn).not.toMatch(/alloca i32 ; h\n/);
      expect(body(ll, "capturedParam")).not.toMatch(/alloca i32 ; seed\n/);

      // Generator and async frames keep doubles.
      for (const name of ["frames", "suspended"]) {
        const fns = functionsWith(ll, new RegExp(`^define [^\\n]*${name}`));
        expect(fns.length).toBeGreaterThan(0);
        for (const fn of fns) expect(fn).not.toMatch(/alloca i32 ; (?:h|total)\n/);
      }

      // Int32 contract locals and parameters use the same storage; the
      // parameter arrives as an i32 and is stored without a conversion.
      const contract = body(ll, "contract");
      expect(contract).toMatch(/alloca i32 ; acc\n/);
      expect(contract).toMatch(/alloca i32 ; seed\n/);
      expect(contract).toMatch(/store i32 %p_sc_l_seed_\w+\.i32, ptr /);
      expect(contract).not.toMatch(/ = fptosi double %p_/);
      expect(carriers(contract)).toEqual([]);

      // A parameter the body never writes reads as its incoming double:
      // the base case returns it without converting the i32 back.
      const fibo = live(body(ll, "fibo"));
      expect(fibo).toMatch(/alloca i32 ; n\n/);
      const nReads = new Set(
        [...fibo.matchAll(/^\s*(%[\w.]+) = load i32, ptr %sc_l_n_\w+$/gm)].map((m) => m[1]),
      );
      const widened = [...fibo.matchAll(/^\s*%[\w.]+ = sitofp i32 (%[\w.]+) to double$/gm)];
      expect(widened.filter((m) => nReads.has(m[1]))).toEqual([]);
      expect(fibo).toMatch(/store double %p_sc_l_n_\w+, ptr /);
    }

    // Debug builds keep every number local a double for the variable view.
    const debug = emitLlvmModule(mod, { debugSources: new Map([[entry, source]]) });
    expect(debug).not.toMatch(/alloca i32 ; (?:s1|h|acc)\n/);
    expect(debug).toMatch(/alloca double ; s1\n/);
    expect(debug).toContain("@llvm.dbg.declare");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const moduleSource = `
function step(x: number, n: number): number {
  return (x * 31 + n) % 1000003;
}
let v = 1;
for (let r = 0; r < 3; r++) for (let n = 0; n < 1000; n++) v = step(v, n);
let shared = 0;
function readShared(): number {
  return shared * 2;
}
for (let i = 0; i < 10; i++) shared = (shared + i) % 7;
console.log(v, shared, readShared());
`;

test("module numbers private to the initializer keep an i32 local there", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-int32-globals-"));
  try {
    await symlink(join(repoRoot, "node_modules"), join(dir, "node_modules"));
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, moduleSource);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    const ll = emitLlvmModule(mod);
    const init = body(ll, "_x25_init_0");
    // `v` lives in an i32 local that starts at the global's zero value; the
    // loop never touches the global's double.
    expect(init).toMatch(/alloca i32 ; v\n/);
    expect(init).toMatch(/store i32 0, ptr %sc_l__x25_g_\w+_v\n/);
    expect(ll).not.toMatch(/(?:load double, ptr|store double [^,]+, ptr) @sc_g_\w*_v\b/);
    expect(carriers(init)).toEqual([]);
    // Another function reads `shared`: it keeps its global.
    expect(init).not.toMatch(/alloca i32 ; shared\n/);
    expect(init).toMatch(/store double [^,]+, ptr @sc_g_\w*_shared\b/);
    // The narrowed parameter and result facts keep step in i32 arithmetic.
    expect(body(ll, "step")).toMatch(/ = urem i32 /);
    expect(body(ll, "step")).not.toMatch(/ = urem i64 /);

    // Debug builds keep the global for the variable view.
    const debug = emitLlvmModule(mod, { debugSources: new Map([[entry, moduleSource]]) });
    expect(debug).not.toMatch(/alloca i32 ; v\n/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("retrying initializers keep private fractions in a double local", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-f64-globals-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    const source = `
let fraction = 0.5;
for (let i = 0; i < 4; i++) fraction += 0.25;
console.log(fraction);
`;
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    const ll = emitLlvmModule(mod);
    expect(ll).toMatch(/alloca double ; module binding fraction\n/);
    expect(ll).not.toMatch(/alloca i32 ; fraction\n/);
    // Only the activation's entry reads the global; the loop uses the local.
    expect([...ll.matchAll(/load double, ptr @sc_g_\w*_fraction\b/g)]).toHaveLength(1);
    expect(ll).not.toMatch(/store double [^,]+, ptr @sc_g_\w*_fraction\b/);
    const debug = emitLlvmModule(mod, { debugSources: new Map([[entry, source]]) });
    expect(debug).not.toMatch(/alloca double ; module binding fraction\n/);
    expect(debug).toMatch(/store double [^,]+, ptr @sc_g_\w*_fraction\b/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
