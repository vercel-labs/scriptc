import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import type { IrFunction, IrModule } from "../src/ir/ir.js";
import { markInt32ArrayCandidates, selectInt32Arrays } from "../src/ir/int32-arrays.js";
import { analyzeInt32Slots, type Int32Slots } from "../src/ir/int32-slots.js";
import { serializeModule } from "../src/ir/serialize.js";

async function emitLlvm(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-int32-elements-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ll");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "llvm" });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    return await readFile(outPath, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function lowerIr(source: string): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-int32-elements-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    return deserializeModule(await readFile(outPath, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const source = `
function compose(n: number, rounds: number): number {
  const p: number[] = [];
  const q: number[] = [];
  for (let i = 0; i < n; i++) p.push((i * 7919 + 3) & (n - 1));
  for (let i = 0; i < n; i++) q.push(i);
  let check = 0;
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < n; i++) q[i] = p[q[i]!]!;
    check = (check + q[r % n]!) | 0;
  }
  return check;
}
function counts(n: number): number {
  const c = new Array(n).fill(0) as number[];
  for (let i = 0; i < n; i++) c[(i * 5) % n] = i;
  while (c.length > 1) c.pop();
  return c[0]!;
}
function fraction(n: number): number {
  const a = [1, 2, 3];
  a[1] = n / 3;
  return a[1]!;
}
function negativeZero(): number {
  const a = [1, -0];
  return 1 / a[1]!;
}
function counter(n: number): number {
  const a = new Array(n).fill(0) as number[];
  for (let i = 0; i < 1000; i++) a[i % n] = a[i % n]! + 1;
  return a[0]!;
}
function shortCounter(): number {
  const a = new Array(16).fill(0) as number[];
  for (let i = 0; i < 1000; i++) a[i % 16] = a[i % 16]! + 1;
  return a[0]!;
}
function literalCounter(n: number): number {
  const a = [0];
  for (let i = 0; i < n; i++) a[0] = a[0]! + 1;
  return a[0]!;
}
function walk(n: number, steps: number): number {
  const next: number[] = [];
  for (let i = 0; i < n; i++) next.push(i + 1 < n ? i + 1 : 0);
  let at = next[0]!;
  let total = 0;
  for (let s = 0; s < steps; s++) {
    const t = next[at]!;
    next[at] = at;
    at = t;
    total = (total + at) | 0;
  }
  return total;
}
function joined(n: number): string {
  const a = [n | 0, 2];
  return a.join(",");
}
const { n } = JSON.parse('{"n": 8}') as { n: number };
console.log(
  compose(n | 0, 3),
  counts(n | 0),
  fraction(n),
  negativeZero(),
  counter(n),
  shortCounter(),
  literalCounter(n),
  joined(n),
  walk(n | 0, 5),
);
`;

/** Every function emitted for the source function \`name\` (its int32 ABI
 * body and its wrapper included). */
function functions(llvm: string, name: string): string {
  const pattern = new RegExp(`^define [^@]*@sc_b?f_${name}[.\\w]*\\([^]*?^}`, "gm");
  return [...llvm.matchAll(pattern)].map((m) => m[0]).join("\n");
}

test("arrays storing only int32 elements get 4-byte slots", async () => {
  const llvm = await emitLlvm(source);
  const compose = functions(llvm, "compose");
  expect(compose).not.toBe("");
  // Both arrays are allocated as SCR_ELEM_I32 (7).
  expect(compose.match(/@scr_arr_new_small\(i32 7\)/g)?.length).toBe(2);
  // Reads load an i32 slot; writes store one.
  expect(compose).toMatch(/getelementptr inbounds i32, ptr %\w+, i64 %\w+\n\s+%\w+ = load i32/);
  expect(compose).toMatch(/store i32 %\w+, ptr %\w+, !tbaa/);
  // The element read through the helper's ternary stays in a stack box.
  expect(compose).not.toContain("@scr_union_new_f64");
  expect(compose).not.toMatch(/call [^\n]*@sc_b?f__x25_arr_idxOr/);
  // The fill form and a discarded pop.
  const counts = functions(llvm, "counts");
  expect(counts).toMatch(/@scr_arr_new\(i32 7, i64 0\)/);
  expect(counts).not.toContain("popArray");
});

test("an array that stores a cursor read back from its own elements gets 4-byte slots", async () => {
  const llvm = await emitLlvm(source);
  const walk = functions(llvm, "walk");
  expect(walk).not.toBe("");
  // `at` is assigned `next[at]!` in the loop and stored back into `next`:
  // it holds an int32 whenever the array's elements are int32s.
  expect(walk).toMatch(/@scr_arr_new_small\(i32 7\)/);
  expect(walk).toMatch(/getelementptr inbounds i32, ptr %\w+, i64 %\w+\n\s+%\w+ = load i32/);
});

test("arrays with a store that has no exact integer range, or that escape, keep doubles", async () => {
  const llvm = await emitLlvm(source);
  for (const name of ["fraction", "negativeZero", "joined"]) {
    const fn = functions(llvm, name);
    expect(fn, name).not.toBe("");
    expect(fn, name).not.toMatch(/@scr_arr_new(_small)?\(i32 7/);
    expect(fn, name).not.toContain("arr.kind.");
  }
});

test("a counter array keeps int32 slots with checked stores", async () => {
  const llvm = await emitLlvm(source);
  const counter = functions(llvm, "counter");
  // `a[k] = a[k]! + 1` is an exact integer but no int32 proof: a fill of at
  // least 4096 elements creates SCR_ELEM_I32 storage (SCR_ELEM_F64 for a
  // shorter one), accesses test the kind, and a store widens the array
  // before a value that is not an int32.
  expect(counter).toMatch(
    /fcmp oge double %\w+, [^\n]+\n\s+%\w+ = select i1 %\w+, i32 7, i32 0\n\s+%\w+ = call ptr @scr_arr_new(_small)?\(i32 %\w+/,
  );
  expect(counter).toMatch(/load i8, ptr %\w+[^\n]*\n\s+%\w+ = icmp eq i8 %\w+, 7/);
  expect(counter).toContain("@llvm.fptosi.sat.i32.f64");
  expect(counter).toContain("call void @scr_arr_widen_i32(");
  // Arrays with proven stores take no kind test, and a fill of a constant
  // short length or an array literal keeps doubles.
  for (const name of ["compose", "counts", "shortCounter", "literalCounter"]) {
    const fn = functions(llvm, name);
    expect(fn, name).not.toContain("arr.kind.");
    expect(fn, name).not.toContain("kind.fast");
    expect(fn, name).not.toContain("scr_arr_widen_i32");
  }
  for (const name of ["shortCounter", "literalCounter"])
    expect(functions(llvm, name), name).not.toMatch(/@scr_arr_new(_small)?\(i32 7/);
});

test("a loop over a counter array tests its kind once on entry", async () => {
  const llvm = await emitLlvm(source);
  const counter = functions(llvm, "counter");
  // The loop's fast copy runs while the array holds int32 slots, with no
  // kind test of its own: the sum is an integer, and a sum past the int32
  // range leaves for the third copy, which re-executes the store with kind
  // tests and widens the array.
  expect(counter).toMatch(
    /icmp eq i8 %\w+, 7\n\s+br i1 %\w+, label %kind\.fast\d+, label %kind\.wide/,
  );
  const rest = counter.slice(counter.search(/^kind\.fast\d+:/m));
  // The fast copy is the last one, before the loop's exit or, when the
  // loop is also versioned on `n`'s entry range, before the copy for other
  // entry values.
  const fast = rest.slice(0, rest.search(/^(loop\.e|entry\.slow)\d+:/m));
  expect(fast).not.toBe("");
  expect(fast).not.toMatch(/icmp eq i8 %\w+, 7/);
  expect(fast).toMatch(/add nsw i64 %\w+, 1/);
  expect(fast).toMatch(
    /icmp sle i64 %\w+, 2147483647\n[^\n]*\n\s+br i1 %\w+, label %arr\.store\.i32\d+, label %kind\.resume\d+/,
  );
  expect(fast).toMatch(/store i32 %\w+, ptr %\w+, !tbaa/);
  expect(counter).toMatch(/^kind\.resume\d+:/m);
});

test("only the candidates the proof keeps are rewritten", async () => {
  const mod = await lowerIr(source);
  const proposed = markInt32ArrayCandidates(mod).int32ArrayCandidates ?? [];
  expect(proposed).toEqual(
    expect.arrayContaining(["compose\0p.0", "compose\0q.0", "counts\0c.0", "counter\0a.0"]),
  );
  // An array that reaches `join` is never proposed.
  expect(proposed.some((key) => key.startsWith("joined\0"))).toBe(false);
  // Without a kept candidate, the module is the input itself.
  expect(selectInt32Arrays(mod, () => ({ kept: new Set(), functions: null }))).toBe(mod);
  const kept = new Set(["compose\0p.0", "compose\0q.0"]);
  const selected = selectInt32Arrays(mod, (marked) => ({
    kept: new Set((marked.int32ArrayCandidates ?? []).filter((key) => kept.has(key))),
    functions: null,
  }));
  expect(selected.int32ArrayCandidates).toEqual([...kept]);
  for (const fn of selected.functions)
    if (fn.name !== "compose") expect(fn).toBe(mod.functions.find((f) => f.name === fn.name));
});

const sharedSource = `
const data: number[] = [];
for (let i = 0; i < 64; i++) data.push((i * 7) & 255);
function fnv(values: number[]): number {
  let h = 2166136261;
  for (let i = 0; i < values.length; i++) h = Math.imul(h ^ values[i]!, 16777619) >>> 0;
  return h;
}
function mean(values: number[]): number {
  let s = 0;
  for (let i = 0; i < values.length; i++) s += values[i]!;
  return s / values.length;
}
function first(values: number[]): number {
  return values[0]!;
}
const ints = [1, 2, 3];
const halves = [0.5, 1.5];
const pick: (values: number[]) => number = first;
console.log(fnv(data), mean(ints), mean(halves), pick([4]));
`;

test("arrays passed to helpers and held in module globals get 4-byte slots", async () => {
  const mod = await lowerIr(sharedSource);
  const proposed = markInt32ArrayCandidates(mod).int32ArrayCandidates ?? [];
  // A global and the parameter every call passes it to; a function used as
  // a value keeps its parameter.
  expect(proposed).toEqual(expect.arrayContaining(["\0%g.e.data", "fnv\0values.0"]));
  expect(proposed.some((key) => key.startsWith("first\0"))).toBe(false);
  const llvm = await emitLlvm(sharedSource);
  // The helper reads int32 slots; `mean`, also called with fractions,
  // reads doubles.
  expect(functions(llvm, "fnv")).toMatch(
    /getelementptr inbounds i32, ptr %\w+, i64 %\w+\n\s+%\w+ = load i32/,
  );
  expect(functions(llvm, "mean")).not.toMatch(/getelementptr inbounds i32, ptr/);
  expect(llvm).toMatch(/@scr_arr_new(_small)?\(i32 7/);
});

/** The module selectInt32Arrays selects, the analysis of its last proof,
 * and how many proofs it asked for: with `revising`, each proof revises
 * the functions of candidates that drop. */
function selection(
  mod: IrModule,
  revising: boolean,
): { selected: IrModule; slots: Int32Slots; proofs: number } {
  let slots: Int32Slots | null = null;
  let proofs = 0;
  const selected = selectInt32Arrays(mod, (marked, revise) => {
    proofs++;
    const latest = new Map<string, IrFunction>();
    slots = analyzeInt32Slots(
      marked,
      revising && revise !== null
        ? {
            revise: (fnName, dropped) => {
              const fn = revise(fnName, dropped);
              latest.set(fnName, fn);
              return fn;
            },
          }
        : {},
    );
    const kept = new Set([...slots.int32Arrays, ...slots.checkedInt32Arrays]);
    if (latest.size === 0) return { kept, functions: null };
    return { kept, functions: marked.functions.map((fn) => latest.get(fn.name) ?? fn) };
  });
  return { selected, slots: slots!, proofs };
}

test("one proof that revises dropped candidates selects what rounds of proofs select", async () => {
  for (const program of [source, sharedSource]) {
    const mod = await lowerIr(program);
    const rounds = selection(mod, false);
    const revised = selection(mod, true);
    // The rounds drop a candidate and prove the module again.
    expect(rounds.proofs).toBeGreaterThan(1);
    expect(revised.proofs).toBe(1);
    expect(serializeModule(revised.selected, true)).toBe(serializeModule(rounds.selected, true));
    expect(revised.slots.summary(revised.selected)).toBe(rounds.slots.summary(rounds.selected));
  }
});
