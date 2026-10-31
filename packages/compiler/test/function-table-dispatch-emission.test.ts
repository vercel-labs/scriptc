import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";
import type { IrExpr, IrModule } from "../src/ir/ir.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function emit(source: string): Promise<string> {
  const outDir = await mkdtemp(join(tmpdir(), "scriptc-function-table-"));
  directories.push(outDir);
  const entry = join(outDir, "main.ts");
  await writeFile(entry, source);
  const outPath = join(outDir, "program.ll");
  const result = await compile(entry, { entry, outDir, outPath, outputKind: "llvm" });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return readFile(outPath, "utf8");
}

async function lowerIr(source: string): Promise<IrModule> {
  const outDir = await mkdtemp(join(tmpdir(), "scriptc-function-table-"));
  directories.push(outDir);
  const entry = join(outDir, "main.ts");
  await writeFile(entry, source);
  const outPath = join(outDir, "main.ir.json");
  const result = await compile(entry, { outDir, outPath, outputKind: "ir" });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return deserializeModule(await readFile(outPath, "utf8"));
}

function definition(llvm: string, symbol: string): string {
  const match = new RegExp(`^define internal [^\\n]*@${symbol}(?:\\.i32)?\\([^]*?^}`, "m").exec(
    llvm,
  );
  expect(match, symbol).not.toBeNull();
  return match![0];
}

// A record of functions dispatched by key: the hit lends the stored closure
// to the call (no union box, no lookup through the runtime, no closure
// retain or release), and only a miss tests the key against
// Object.prototype's method names.
const source = `
type Op = (acc: number, arg: number) => number;
const ops: Record<string, Op> = {
  add: (acc, arg) => acc + arg,
  neg: (acc) => -acc,
};
function asserted(name: string, acc: number): number {
  return ops[name]!(acc, 1);
}
function optional(name: string, acc: number): number {
  return ops[name]?.(acc, 1) ?? acc;
}
// Object arguments: the inherited methods' key conversion must not make
// every indirect call a heap writer (which would end all borrowing).
class Point {
  constructor(readonly x: number) {}
}
type Measure = (p: Point, q: Point) => number;
const measures: Record<string, Measure> = { sum: (p, q) => p.x + q.x };
function objects(name: string, p: Point): number {
  return measures[name]!(p, p);
}
function checked(name: string, acc: number): number {
  const handler = ops[name];
  return handler ? handler(acc, 1) : acc;
}
let acc = 1;
for (const name of ["add", "neg", "nope", "toString"]) {
  acc = asserted(name === "nope" ? "add" : name === "toString" ? "neg" : name, acc);
  acc = optional(name, acc);
  acc = checked(name, acc);
  acc += objects(name === "nope" ? "sum" : "sum", new Point(acc));
}
console.log(acc);
`;

test("function-table dispatch borrows the stored closure on a hit", async () => {
  const llvm = await emit(source);
  for (const fn of ["asserted", "optional", "checked", "objects"]) {
    const body = definition(llvm, `sc_bf_${fn}`);
    expect(body, fn).not.toMatch(/scr_union_new_ref|scr_map_get_str_ref/);
    expect(body, fn).not.toMatch(/scr_closure_retain|sc_nretain_func/);
    expect(body, fn).toMatch(/sc_map_entry_str/);
  }
});

// A borrowed ternary whose arms are fallback reads: a miss binds the
// inherited method into a frame-owned slot, which must outlive the arm
// until the call has used the lent closure. The lowering builds no such
// ternary today (a bound read is a call's own callee), so the test wraps
// the callee read of `pick` in one.
test("a borrowed ternary of fallback reads keeps a bound default past its arm", async () => {
  const mod = await lowerIr(`
type Op = (x: string) => string;
const table: Record<string, Op> = { echo: (x) => x };
function pick(name: string, flag: boolean): string {
  return table[name]!("echo");
}
console.log(pick(process.argv[2] ?? "hasOwnProperty", process.argv.length > 3));
`);
  const pick = mod.functions.find((fn) => fn.name === "pick")!;
  const flag = pick.params[1]!;
  let wrapped = 0;
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      const e = value as IrExpr | null;
      if (e !== null && typeof e === "object" && e.kind === "nullish" && e.right.kind === "call") {
        const cond: IrExpr = { kind: "varRef", localId: flag.localId, type: flag.type, loc: e.loc };
        (node as Record<string, unknown>)[key] = {
          kind: "ternary",
          cond,
          then: e,
          else_: structuredClone(e),
          type: e.type,
          loc: e.loc,
        };
        wrapped++;
      } else visit(value);
    }
  };
  visit(pick.body);
  expect(wrapped).toBe(1);
  const body = definition(emitLlvmModule(mod), "sc_bf_pick");
  // Each arm lends its read and leaves: nothing it filled is released
  // before the join.
  const arms = [...body.matchAll(/^read\.(?:then|else)\d+:\n([^]*?)(?=^read\.)/gm)].map(
    (m) => m[1]!,
  );
  expect(arms).toHaveLength(2);
  for (const arm of arms)
    expect(arm).toMatch(/store ptr %t\d+, ptr %s\d+\n {2}br label %read\.end\d+\n$/);
});
