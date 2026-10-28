import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";

interface IrShape {
  names: string[];
  callees: string[];
}

/** Lower one program to IR and collect every function name and call target. */
async function lower(
  source: string,
): Promise<{ ok: true; ir: IrShape } | { ok: false; codes: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-union-array-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok) return { ok: false, codes: result.diagnostics.map((d) => d.code) };
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    const callees: string[] = [];
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (value === null || typeof value !== "object") return;
      const node = value as { kind?: unknown; callee?: unknown };
      if (node.kind === "call" && typeof node.callee === "string") callees.push(node.callee);
      for (const child of Object.values(value)) visit(child);
    };
    visit(mod.functions);
    return { ok: true, ir: { names: mod.functions.map((f) => f.name), callees } };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const helpers = (ir: IrShape, prefix: string): string[] =>
  ir.names.filter((name) => name.startsWith(prefix));

test("a union of tuples into an array slot lifts every arm on its tag", async () => {
  const result = await lower(`
type Variant = ["one"] | ["two", "three"];
function pick(flag: boolean): Variant {
  return flag ? ["one"] : ["two", "three"];
}
function take(xs: string[]): number {
  return xs.length;
}
console.log(take(pick(true)));
export {};
`);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const arrayHelpers = helpers(result.ir, "%union.arr");
  expect(arrayHelpers.length).toBeGreaterThan(0);
  // The conversion is a call to the arm-dispatching helper, not a narrowed
  // extraction of one tuple arm.
  for (const name of arrayHelpers) expect(result.ir.callees).toContain(name);
});

test("the as const key-table shape lowers through the same helper", async () => {
  const result = await lower(`
const SEQUENCES = { up: ["\\x1b[A", "\\x1bOA"], f9: ["\\x1b[20~"] } as const;
type SequenceKey = keyof typeof SEQUENCES;
function matches(data: string, sequences: readonly string[]): boolean {
  return sequences.includes(data);
}
console.log(matches("\\x1bOA", SEQUENCES["up" as SequenceKey]));
export {};
`);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(helpers(result.ir, "%union.arr").length).toBeGreaterThan(0);
});

test("a single tuple keeps the existing tuple-to-array path", async () => {
  const result = await lower(`
const single: ["x", "y"] = ["x", "y"];
const widened: string[] = single;
console.log(widened.join(""));
export {};
`);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(helpers(result.ir, "%tup.arr").length).toBeGreaterThan(0);
  expect(helpers(result.ir, "%union.arr")).toEqual([]);
});

test("a union that already holds the array arm keeps its checked extraction", async () => {
  const result = await lower(`
type T = string[] | ["a"];
function pick(flag: boolean): T {
  return flag ? ["b", "c"] : ["a"];
}
const widened: string[] = pick(true);
console.log(widened.length);
export {};
`);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  // `string[]` is an arm, so the conversion this program always used — the
  // checked extraction of that arm — must stay byte-identical: the new union
  // array lift is only for unions with no arm the slot can hold.
  expect(helpers(result.ir, "%union.narrow").length).toBeGreaterThan(0);
  expect(helpers(result.ir, "%union.arr")).toEqual([]);
});

test("a union holding an undefined arm still lowers through the helper", async () => {
  const result = await lower(`
type Pair = [string, string] | [string];
const table: Record<string, Pair> = { one: ["a", "b"] };
const widened: string[] = table["one"]!;
console.log(widened.join(""));
export {};
`);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(helpers(result.ir, "%union.arr").length).toBeGreaterThan(0);
});
