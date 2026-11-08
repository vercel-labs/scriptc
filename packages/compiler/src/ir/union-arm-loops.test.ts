import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../index.js";
import { versionUnionArmLoops } from "./union-arm-loops.js";
import { validateModule } from "./validate.js";
import type { IrExpr, IrFunction, IrModule, IrStmt } from "./ir.js";
import { everyExprChild, everyStmtChild, everyStmtList } from "./traverse.js";

async function lower(source: string): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-union-arms-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    return deserializeModule(await readFile(outPath, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const fn = (mod: IrModule, name: string): IrFunction => mod.functions.find((f) => f.name === name)!;

function count(f: IrFunction, match: (node: IrExpr | IrStmt) => boolean): number {
  let found = 0;
  everyStmtList(f.body, {
    stmt: (s) => {
      if (match(s)) found++;
      return true;
    },
    expr: (e) => {
      if (match(e)) found++;
      return true;
    },
  });
  return found;
}

const loops = (f: IrFunction): number =>
  count(f, (n) => n.kind === "for" || n.kind === "while" || n.kind === "doWhile");

/** Narrows and tag tests left on the source value. */
const narrowsOn = (f: IrFunction, id: string): number =>
  count(f, (e) => e.kind === "unionNarrow" && e.value.kind === "varRef" && e.value.localId === id);
const testsOn = (f: IrFunction, id: string): number =>
  count(f, (e) => e.kind === "unionIsTag" && e.value.kind === "varRef" && e.value.localId === id);

/** Narrows of the source inside a loop, where they run per element. */
function narrowsInLoops(f: IrFunction, id: string): number {
  let found = 0;
  const isLoopStmt = (s: IrStmt): boolean =>
    s.kind === "for" || s.kind === "while" || s.kind === "doWhile";
  // A binding declaration's own narrow runs once per region, not once per
  // element; only the dispatch the copies keep would.
  const visitExpr = (e: IrExpr, depth: number, binding: boolean): void => {
    if (
      depth > 0 &&
      !binding &&
      e.kind === "unionNarrow" &&
      e.value.kind === "varRef" &&
      e.value.localId === id
    )
      found++;
    everyExprChild(
      e,
      (child) => (visitExpr(child, depth, false), true),
      (child) => (visitStmt(child, depth), true),
    );
  };
  const visitStmt = (s: IrStmt, depth: number): void => {
    const nested = depth + (isLoopStmt(s) ? 1 : 0);
    everyStmtChild(
      s,
      (child) => (visitExpr(child, nested, s.kind === "varDecl"), true),
      (child) => (visitStmt(child, nested), true),
    );
  };
  for (const statement of f.body) visitStmt(statement, 0);
  return found;
}

const UNION = `
type UintArray = Uint8Array | Uint16Array | Uint32Array;
`;

test("a loop that indexes a typed-array union binds each arm before the loop", async () => {
  const before = await lower(`${UNION}
function fill(xs: UintArray, rounds: number): number {
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < xs.length; i++) xs[i] = i & 255;
  }
  return xs.length;
}
console.log(fill(new Uint32Array(4), 2));
`);
  expect(loops(fn(before, "fill"))).toBe(2);
  expect(narrowsOn(fn(before, "fill"), "xs.0")).toBeGreaterThan(0);

  const after = versionUnionArmLoops(before);
  const fill = fn(after, "fill");
  // Two nested loops per arm: the outer loop's body was copied, the inner one
  // with it.
  expect(loops(fill)).toBe(6);
  // One tag test per arm but the last on the loop's source value, plus the
  // two the return's own `xs.length` dispatch keeps: every per-element
  // dispatch inside the loop is gone.
  expect(testsOn(fill, "xs.0")).toBe(4);
  expect(narrowsInLoops(fill, "xs.0")).toBe(0);
  const bound = fill.locals.filter((l) => l.id.startsWith("xs.arm"));
  expect(bound.map((l) => l.type.kind)).toEqual(["bytes", "bytes", "bytes"]);
  expect(bound.every((l) => !l.mutable)).toBe(true);
  // Each copy indexes the bound local: three loops, one store each.
  expect(
    count(
      fill,
      (n) => n.kind === "bytesSet" && n.arr.kind === "varRef" && n.arr.localId.startsWith("xs.arm"),
    ),
  ).toBe(3);
  expect(validateModule(after)).toEqual([]);
});

test("an inner loop's own union is bound too, one region per loop", async () => {
  const before = await lower(`${UNION}
type Words = Uint8Array | Uint16Array;
function copy(xs: UintArray, ys: Words): void {
  for (let i = 0; i < xs.length; i++) {
    for (let j = 0; j < ys.length; j++) ys[j] = xs[i]!;
  }
}
copy(new Uint8Array(4), new Uint16Array(4));
`);
  const after = versionUnionArmLoops(before);
  const copy = fn(after, "copy");
  // The outer loop takes three copies; the inner loop inside each of them
  // takes two (Uint8Array | Uint16Array): six inner loops, and the outer
  // loop is not copied again.
  expect(loops(copy)).toBe(3 + 6);
  expect(narrowsInLoops(copy, "xs.0")).toBe(0);
  expect(narrowsInLoops(copy, "ys.0")).toBe(0);
  expect(validateModule(after)).toEqual([]);
});

test("a while loop over the union is bound as well", async () => {
  const before = await lower(`${UNION}
function sum(xs: UintArray, n: number): number {
  let total = 0;
  let i = 0;
  while (i < n) {
    total += xs[i]!;
    i++;
  }
  return total;
}
console.log(sum(new Uint8Array(4), 4));
`);
  const after = versionUnionArmLoops(before);
  expect(loops(fn(after, "sum"))).toBe(3);
  expect(narrowsInLoops(fn(after, "sum"), "xs.0")).toBe(0);
  expect(validateModule(after)).toEqual([]);
});

test("a source the function reassigns is not bound", async () => {
  const before = await lower(`${UNION}
function sum(xs: UintArray, ys: UintArray, n: number): number {
  let total = 0;
  for (let i = 0; i < n; i++) {
    total += xs[i]!;
    if (i === 3) xs = ys;
  }
  return total;
}
console.log(sum(new Uint8Array(4), new Uint16Array(4), 4));
`);
  const after = versionUnionArmLoops(before);
  expect(after).toBe(before);
});

test("a union with a unit arm is left alone", async () => {
  const before = await lower(`
type MaybeArray = Uint8Array | undefined;
function fill(xs: MaybeArray, n: number): void {
  for (let i = 0; i < n; i++) if (xs !== undefined) xs[i] = i & 255;
}
fill(new Uint8Array(4), 4);
`);
  const after = versionUnionArmLoops(before);
  expect(after).toBe(before);
});

test("a loop that only reads the length keeps its dispatch", async () => {
  const before = await lower(`${UNION}
function size(xs: UintArray): number {
  let n = 0;
  for (let i = 0; i < 3; i++) n += xs.length;
  return n;
}
console.log(size(new Uint8Array(4)));
`);
  const after = versionUnionArmLoops(before);
  expect(after).toBe(before);
});

test("a union without typed-array arms is left alone", async () => {
  const before = await lower(`
function scan(values: (string | number)[]): number {
  let n = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    n += typeof v === "number" ? v : v.length;
  }
  return n;
}
console.log(scan([1, "a"]));
`);
  const after = versionUnionArmLoops(before);
  expect(after).toBe(before);
});

test("a loop body over the size limit keeps its dispatch", async () => {
  const body = Array.from(
    { length: 90 },
    (_, i) => `    if (xs[i]! === ${i}) total += xs[i]!;`,
  ).join("\n");
  const before = await lower(`${UNION}
function scan(xs: UintArray): number {
  let total = 0;
  for (let i = 0; i < xs.length; i++) {
${body}
  }
  return total;
}
console.log(scan(new Uint8Array(4)));
`);
  expect(narrowsOn(fn(before, "scan"), "xs.0")).toBeGreaterThan(0);
  const after = versionUnionArmLoops(before);
  expect(after).toBe(before);
});

test("nested loops over three unions stay within the function's version budget", async () => {
  const before = await lower(`
type Bytes = Uint8Array | Uint16Array | Uint32Array | Int8Array;
function nest(xs: Bytes, ys: Bytes, zs: Bytes, n: number): number {
  let total = 0;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      for (let k = 0; k < n; k++) {
        xs[k] = ys[j]! + zs[i]!;
        total += xs[k]!;
      }
  return total;
}
console.log(nest(new Uint8Array(2), new Uint16Array(2), new Uint32Array(2), 2));
`);
  const after = versionUnionArmLoops(before);
  const nest = fn(after, "nest");
  // Nested copies multiply; the function-level budget bounds how much the
  // versions add to the function.
  expect(count(nest, () => true)).toBeLessThanOrEqual(count(fn(before, "nest"), () => true) + 2000);
  expect(loops(nest)).toBeGreaterThan(loops(fn(before, "nest")));
  expect(validateModule(after)).toEqual([]);
});
