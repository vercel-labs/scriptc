import { expect, test } from "vitest";
import { emitLlvmModule } from "../backend/llvm/emitter.js";
import { analyzeIntegerRanges } from "./integer-ranges.js";
import { F64, VOID, type IrExpr, type IrModule, type IrStmt } from "./ir.js";
import { deserializeModule, serializeModule } from "./serialize.js";
import { everyStmtList } from "./traverse.js";
import { unshareNodes } from "./unshare.js";
import { validateModule } from "./validate.js";

const loc = { file: "unshare.ts", start: 0, end: 1 };
const num = (value: number): IrExpr => ({
  kind: "numLit",
  value,
  type: F64,
  loc,
});
const add = (left: IrExpr, right: IrExpr): IrExpr => ({
  kind: "bin",
  op: "+",
  left,
  right,
  type: F64,
  loc,
});

/** One varRef object read at two sites: `x` is unknown at the first and
 * exactly 5 at the second, as lowering helpers that reuse a read produce;
 * and one `p + 2` expression stored at two sites. */
function sharedRead(): { mod: IrModule; read: IrExpr } {
  const read: IrExpr = { kind: "varRef", localId: "x", type: F64, loc };
  const twice = add({ kind: "varRef", localId: "p", type: F64, loc }, num(2));
  const body: IrStmt[] = [
    {
      kind: "varDecl",
      localId: "x",
      init: { kind: "varRef", localId: "p", type: F64, loc },
      loc,
    },
    { kind: "varDecl", localId: "a", init: add(read, num(1)), loc },
    { kind: "assign", localId: "x", value: num(5), loc },
    { kind: "varDecl", localId: "b", init: add(read, num(1)), loc },
    // A repeated node with children: its leaves repeat with it.
    { kind: "varDecl", localId: "c", init: twice, loc },
    { kind: "assign", localId: "c", value: twice, loc },
    {
      kind: "return",
      value: add(
        { kind: "varRef", localId: "a", type: F64, loc },
        {
          kind: "varRef",
          localId: "b",
          type: F64,
          loc,
        },
      ),
      loc,
    },
  ];
  const mod: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "main",
    functions: [
      { name: "main", loc, params: [], locals: [], returnType: VOID, body: [] },
      {
        name: "f",
        loc,
        params: [{ name: "p", localId: "p", type: F64 }],
        locals: ["p", "x", "a", "b", "c"].map((id) => ({
          id,
          name: id,
          type: F64,
          mutable: true,
        })),
        returnType: F64,
        body,
      },
    ],
  };
  return { mod, read };
}

function nodes(mod: IrModule): (IrExpr | IrStmt)[] {
  const out: (IrExpr | IrStmt)[] = [];
  const visit = (node: IrExpr | IrStmt): boolean => (out.push(node), true);
  for (const fn of mod.functions) everyStmtList(fn.body, { expr: visit, stmt: visit });
  return out;
}

test("every occurrence gets its own node without mutating the input", () => {
  const { mod, read } = sharedRead();
  const before = serializeModule(mod);
  const tree = unshareNodes(mod);
  expect(serializeModule(mod)).toBe(before);
  expect(serializeModule(tree)).toBe(before);
  const all = nodes(tree);
  expect(new Set(all).size).toBe(all.length);
  expect(all).not.toContain(read);
  // The entry function had no shared node and is kept as it is.
  expect(tree.functions[0]).toBe(mod.functions[0]);
  expect(unshareNodes(tree)).toBe(tree);
});

test("ranges are per occurrence once nodes are unshared", () => {
  const { mod, read } = sharedRead();
  // Keyed by identity, the shared read holds the join of both sites.
  expect(analyzeIntegerRanges(mod.functions[1]!).get(read)).toBeNull();
  const fn = unshareNodes(mod).functions[1]!;
  const reads = nodes({ ...mod, functions: [fn] }).filter(
    (node) => node.kind === "varRef" && node.localId === "x",
  );
  const ranges = analyzeIntegerRanges(fn);
  expect(reads.map((node) => ranges.get(node as IrExpr) ?? null)).toEqual([
    null,
    { min: 5, max: 5 },
  ]);
});

test("emission matches the module read back from its serialized form", () => {
  const { mod } = sharedRead();
  expect(validateModule(mod)).toEqual([]);
  const restored = deserializeModule(serializeModule(mod, true));
  expect(emitLlvmModule(mod)).toBe(emitLlvmModule(restored));
});
