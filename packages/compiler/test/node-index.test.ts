import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import type { IrExpr, IrFunction, IrModule, IrStmt, IrType } from "../src/ir/ir.js";
import { emitRangeStarts } from "../src/backend/llvm/emit-module.js";
import {
  eachNodeOfKinds,
  IrNodeIndex,
  type IrNodeKind,
  lacksKinds,
  lacksNode,
  LOCAL_BINDING_KINDS,
} from "../src/ir/node-index.js";
import { everyModuleNode, everyStmtList } from "../src/ir/traverse.js";
import { serializeModule } from "../src/ir/serialize.js";
import { addRecordResultEntries } from "../src/backend/llvm/record-results.js";
import { specializeCallbackCalls } from "../src/ir/callback-specialization.js";
import { copyStableCaptures } from "../src/ir/capture-values.js";
import { holdCharLocalsAsUnits } from "../src/ir/char-unit-locals.js";
import { foldConstantGlobals } from "../src/ir/constant-globals.js";
import { inlineExpressionFunctions } from "../src/ir/expression-inlining.js";
import { hoistFinalFieldReads } from "../src/ir/field-values.js";
import { freezeInitOnlyGlobals } from "../src/ir/init-only-globals.js";
import { specializeNumericCalls } from "../src/ir/numeric-call-specialization.js";
import { runPairedWhileLoopsAsFor } from "../src/ir/paired-while-loops.js";
import { versionLoopBoundParameters } from "../src/ir/parameter-versions.js";
import { dropUnwrittenPropertyBags } from "../src/ir/property-bags.js";
import { pairRowSums } from "../src/ir/row-pairs.js";
import { jamSaturatingLoops } from "../src/ir/saturating-loop-jams.js";
import { scalarizeLiteralResults } from "../src/ir/scalar-records.js";
import { resolveSelfCaptures } from "../src/ir/self-captures.js";

async function lowerSource(source: string): Promise<IrModule> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-node-index-"));
  try {
    const entry = join(dir, "main.ts");
    await writeFile(entry, source);
    const outPath = join(dir, "main.ir.json");
    const result = await compile(entry, { outPath, outDir: dir, outputKind: "ir" });
    if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
    return deserializeModule(await readFile(outPath, "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

let mod: IrModule;
let index: IrNodeIndex;

beforeAll(async () => {
  mod = await lowerSource(`
class Shape {
  constructor(public readonly name: string, protected sides: number[]) {}
  area(): number { return 0; }
}
class Square extends Shape {
  constructor(private side: number) { super("square", [side, side, side, side]); }
  override area(): number { return this.side * this.side; }
}
type Result = { ok: true; value: number } | { ok: false; error: string };
function parse(text: string): Result {
  const n = Number(text);
  return Number.isNaN(n) ? { ok: false, error: "bad " + text } : { ok: true, value: n };
}
function* count(limit: number): Generator<number> {
  for (let i = 0; i < limit; i++) yield i;
}
const totals = new Map<string, number>();
const seen = new Set<string>();
let calls = 0;
function record(key: string, value: number): void {
  calls++;
  totals.set(key, (totals.get(key) ?? 0) + value);
  seen.add(key);
}
const adder = (k: number) => (x: number): number => x + k;
const inc = adder(1);
try {
  for (const text of ["1", "x", "3"]) {
    const r = parse(text);
    if (r.ok) record("ok", inc(r.value));
    else throw new Error(r.error);
  }
} catch (e) {
  record("error", String(e).length);
}
let sum = 0;
for (const v of count(4)) sum += v;
const shapes: Shape[] = [new Square(2), new Shape("none", [])];
console.log(sum, calls, [...totals], seen.size, shapes.map((s) => s.area()).join(","));
`);
  index = new IrNodeIndex(mod);
});

/** Every node everyStmtList visits in `body`, with whether it is a statement. */
function walked(body: IrStmt[]): [IrExpr | IrStmt, boolean][] {
  const out: [IrExpr | IrStmt, boolean][] = [];
  everyStmtList(body, {
    expr: (node) => (out.push([node, false]), true),
    stmt: (node) => (out.push([node, true]), true),
  });
  return out;
}

function noted(
  fn: IrModule["functions"][number],
  scan: ReturnType<IrNodeIndex["scan"]> | undefined,
): [IrExpr | IrStmt, boolean][] {
  const out: [IrExpr | IrStmt, boolean][] = [];
  eachNodeOfKinds(fn, scan, (node, statement) => {
    out.push([node, statement]);
  });
  return out;
}

const NO_KINDS: ReadonlySet<string> = new Set();

test("the index visits each body's nodes in everyStmtList's order", () => {
  expect(mod.functions.length).toBeGreaterThan(5);
  const all = index.scanExcept(NO_KINDS);
  for (const fn of mod.functions) expect(noted(fn, all)).toEqual(walked(fn.body));
});

const SOME_KINDS: readonly IrNodeKind[] = ["call", "varDecl", "closure", "return", "fieldGet"];

test("a scan visits only its kinds, in walk order, and the walk answers the same", () => {
  const scan = index.scan(SOME_KINDS);
  let visited = 0;
  for (const fn of mod.functions) {
    const expected = walked(fn.body).filter(([node]) => SOME_KINDS.includes(node.kind));
    expect(noted(fn, scan)).toEqual(expected);
    // Without a scan, every node reaches `note`, as the walk visits them.
    expect(noted(fn, undefined)).toEqual(walked(fn.body));
    visited += expected.length;
  }
  expect(visited).toBeGreaterThan(20);
  expect(index.scan(SOME_KINDS)).toBe(scan);
});

test("a false answer stops the visit, with or without the index", () => {
  const all = index.scanExcept(NO_KINDS);
  for (const fn of mod.functions) {
    for (const scan of [all, undefined]) {
      let calls = 0;
      eachNodeOfKinds(fn, scan, () => ++calls < 3);
      expect(calls).toBe(Math.min(3, walked(fn.body).length));
    }
  }
});

test("a function's node count is the number of nodes its visit notes", () => {
  const all = index.scanExcept(NO_KINDS);
  for (const fn of mod.functions) expect(index.nodeCount(fn)).toBe(noted(fn, all).length);
  expect(index.nodeCount({ ...mod.functions[0]! })).toBeUndefined();
});

test("emission ranges cover the functions in order, none empty, of about equal cost", () => {
  const count = (fn: IrFunction): number | undefined => index.nodeCount(fn);
  for (const ranges of [1, 2, 3, mod.functions.length, mod.functions.length + 4]) {
    const starts = emitRangeStarts(mod.functions, ranges, count);
    expect(starts[0]).toBe(0);
    expect(starts.at(-1)).toBe(mod.functions.length);
    expect(starts.length - 1).toBeLessThanOrEqual(ranges);
    for (let i = 1; i < starts.length; i++) expect(starts[i]!).toBeGreaterThan(starts[i - 1]!);
  }
  // Equal costs split into equal ranges. A range ends after the function
  // that reaches its share of the cost, so a large function ends its range.
  const functions = Array.from({ length: 12 }, () => mod.functions[0]!);
  expect(emitRangeStarts(functions, 4, () => 0)).toEqual([0, 3, 6, 9, 12]);
  const sizes = [0, 0, 1000, 0, 0, 0];
  const uneven = sizes.map((_, i) => ({ ...mod.functions[0]!, name: `f${i}` }));
  const bySize = new Map(uneven.map((fn, i) => [fn, sizes[i]!]));
  expect(emitRangeStarts(uneven, 3, (fn) => bySize.get(fn))).toEqual([0, 3, 4, 6]);
});

test("a function the index did not record is walked", () => {
  const all = index.scanExcept(NO_KINDS);
  for (const fn of mod.functions) {
    const copy = { ...fn };
    expect(index.visit(copy, all, () => {})).toBe(false);
    expect(noted(copy, all)).toEqual(walked(fn.body));
  }
});

test("the expression scan visits every expression", () => {
  const expressions = index.expressions();
  for (const fn of mod.functions)
    expect(noted(fn, expressions)).toEqual(walked(fn.body).filter(([, statement]) => !statement));
});

test("the index's types are the type objects everyModuleNode visits, each once", () => {
  const visited = new Set<IrType>();
  everyModuleNode(mod, {
    expr: () => true,
    stmt: () => true,
    type: (type) => (visited.add(type), true),
  });
  expect(new Set(index.types)).toEqual(visited);
  expect(index.types.length).toBe(visited.size);
});

test("a kind no node has matches nothing", () => {
  const scan = index.scan(["regexLit"]);
  for (const fn of mod.functions) expect(noted(fn, scan)).toEqual([]);
});

test("an index built from a previous one holds the nodes a fresh index holds", () => {
  // A later module: one function rewritten (a new object), one dropped, the
  // others shared with the indexed module.
  const [first, second, ...rest] = mod.functions;
  const rewritten: IrFunction = { ...first!, body: [...first!.body] };
  const later: IrModule = { ...mod, functions: [...rest, rewritten] };
  const reused = new IrNodeIndex(later, index);
  const fresh = new IrNodeIndex(later);
  const all = reused.scanExcept(NO_KINDS);
  for (const fn of later.functions) {
    expect(noted(fn, all)).toEqual(noted(fn, fresh.scanExcept(NO_KINDS)));
    expect(reused.nodeCount(fn)).toBe(fresh.nodeCount(fn));
  }
  expect(reused.nodeCount(second!)).toBeUndefined();
  const scan = reused.scan(SOME_KINDS);
  for (const fn of later.functions)
    expect(noted(fn, scan)).toEqual(
      walked(fn.body).filter(([node]) => SOME_KINDS.includes(node.kind)),
    );
  // Positions resolve across the two indexes, as across processes.
  const wanted = new Set<IrExpr>();
  for (const fn of later.functions)
    for (const [node, statement] of walked(fn.body))
      if (!statement && node.kind === "call") wanted.add(node as IrExpr);
  expect(wanted.size).toBeGreaterThan(3);
  const positions = reused.expressionPositions(wanted);
  expect(positions).toEqual(fresh.expressionPositions(wanted));
  expect(new Set(fresh.expressionsAt(positions!))).toEqual(wanted);
  expect(new Set(reused.types)).toEqual(new Set(fresh.types));
});

test("lacksKinds and lacksNode answer for the functions the index records", () => {
  const scan = index.scan(SOME_KINDS);
  for (const fn of mod.functions) {
    const kinds = walked(fn.body).filter(([node]) => SOME_KINDS.includes(node.kind));
    expect(lacksKinds(fn, scan)).toBe(kinds.length === 0);
    const calls = kinds.filter(([node]) => node.kind === "call").length;
    expect(lacksNode(fn, scan, (node) => node.kind === "call")).toBe(calls === 0);
    expect(lacksNode(fn, scan, () => false)).toBe(true);
    // Without a scan, or for a function the index did not record, neither
    // answers that a kind is absent.
    expect(lacksKinds(fn, undefined)).toBe(false);
    expect(lacksNode(fn, undefined, () => false)).toBe(false);
    expect(lacksKinds({ ...fn }, scan)).toBe(false);
    expect(lacksNode({ ...fn }, scan, () => false)).toBe(false);
  }
});

test("the local binding kinds are the kinds whose nodes name a local in localId", () => {
  const seen = new Set<string>();
  for (const fn of mod.functions)
    for (const [node] of walked(fn.body))
      if (node.kind !== "varRef" && "localId" in node && typeof node.localId === "string")
        seen.add(node.kind);
  expect(seen.size).toBeGreaterThan(1);
  for (const kind of seen) expect(LOCAL_BINDING_KINDS).toContain(kind);
});

test("the module passes give the same module with and without an index", async () => {
  const passes = await lowerSource(`
const LIMIT = 8;
class Grid {
  constructor(readonly width: number, readonly cells: number[]) {}
}
function sum(grid: Grid): number {
  let total = 0;
  for (let y = 0; y < LIMIT; y++) for (let x = 0; x < grid.width; x++) total += grid.cells[x]!;
  return total;
}
function reverse(values: number[]): void {
  let lo = 0, hi = values.length - 1;
  while (lo < hi) { const t = values[lo]!; values[lo] = values[hi]!; values[hi] = t; lo++; hi--; }
}
function digits(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) { const c = text[i]; if (c >= "0" && c <= "9") n++; }
  return n;
}
function pair(i: number, j: number): number { return ((i + j) * (i + j + 1)) / 2 + j; }
function apply(values: number[], f: (v: number) => number): number[] { return values.map(f); }
function scale(v: number, by?: number): number { return v * (by ?? 2); }
function split(text: string, at: number): [string, string] { return [text.slice(0, at), text.slice(at)]; }
const visit = (n: number): number => (n <= 0 ? 0 : 1 + visit(n - 1));
const values = [3, 1, 2];
reverse(values);
let paired = 0;
for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) paired += pair(i, j);
const [head, tail] = split("scriptc", 3);
console.log(sum(new Grid(3, values)), digits("a1b22"), paired, apply(values, (v) => v + 1),
  apply(values, (v) => v * 2), scale(1), scale(1, 3), head, tail.length, visit(3));
`);
  const run = (nodes: IrNodeIndex | undefined): string => {
    let current = passes;
    const step = (pass: (mod: IrModule, nodes?: IrNodeIndex) => IrModule): void => {
      current = pass(current, nodes);
    };
    step(runPairedWhileLoopsAsFor);
    step(dropUnwrittenPropertyBags);
    step(holdCharLocalsAsUnits);
    step(freezeInitOnlyGlobals);
    step(hoistFinalFieldReads);
    step(resolveSelfCaptures);
    step(copyStableCaptures);
    step(foldConstantGlobals);
    step(inlineExpressionFunctions);
    step(jamSaturatingLoops);
    step(pairRowSums);
    step((mod, index) => specializeNumericCalls(mod, undefined, index));
    step((mod, index) => specializeCallbackCalls(mod, undefined, index));
    step(scalarizeLiteralResults);
    step(addRecordResultEntries);
    step((mod, index) => versionLoopBoundParameters(mod, undefined, index));
    return serializeModule(current);
  };
  const walkedPasses = run(undefined);
  expect(run(new IrNodeIndex(passes))).toBe(walkedPasses);
  expect(walkedPasses).not.toBe(serializeModule(passes));
});

test("the parameter-version pass reads its loops, sizes and call sites from the index", async () => {
  const module = await lowerSource(`
function sumTo(n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) s += i;
  return s;
}
const n = Number(process.argv.length > 5 ? "7.5" : "6");
console.log(sumTo(n));
`);
  const index = new IrNodeIndex(module);
  const consulted: string[] = [];
  const spy = {
    scan: (kinds: readonly IrNodeKind[]) => {
      consulted.push("scan");
      return index.scan(kinds);
    },
    nodeCount: (fn: IrFunction) => {
      consulted.push("nodeCount");
      return index.nodeCount(fn);
    },
  } as unknown as IrNodeIndex;
  const fromIndex = serializeModule(versionLoopBoundParameters(module, undefined, spy));
  expect(consulted.length).toBeGreaterThan(0);
  expect(fromIndex).toBe(serializeModule(versionLoopBoundParameters(module, undefined)));
  expect(fromIndex).not.toBe(serializeModule(module));
});
