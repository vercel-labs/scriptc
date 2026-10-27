import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";
import type { IrExpr, IrModule, IrStmt, IrType } from "../src/ir/ir.js";
import { eachNodeOfKinds, IrNodeIndex, type IrNodeKind } from "../src/ir/node-index.js";
import { everyModuleNode, everyStmtList } from "../src/ir/traverse.js";

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
