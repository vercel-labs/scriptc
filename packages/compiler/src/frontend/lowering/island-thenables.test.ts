import { expect, test } from "vitest";
import { DYN, VOID, type IrExpr, type IrFunction, type IrStmt, type SrcLoc } from "../../ir/ir.js";
import { adoptIslandThenables } from "./island-thenables.js";
import { ENTRY_NAME, type Lowerer } from "./lowerer.js";

const loc: SrcLoc = { file: "main.mjs", start: 0, end: 1 };
const fn = (name: string, body: IrStmt[]): IrFunction => ({
  name,
  body,
  params: [],
  locals: [],
  returnType: VOID,
  loc,
});
const operand = (): IrExpr => ({ kind: "varRef", localId: "%v", type: DYN, loc }) as IrExpr;
const awaitDyn = (): IrExpr & { kind: "libCall" } => ({
  kind: "libCall",
  fn: "async.awaitDyn",
  args: [operand()],
  type: DYN,
  loc,
});

test("a program with Node islands adopts island thenables at every dynamic await", () => {
  const first = awaitDyn();
  const resolve: IrExpr & { kind: "libCall" } = {
    kind: "libCall",
    fn: "dyn.promiseResolve",
    args: [operand(), operand()],
    type: { kind: "promise", inner: DYN },
    loc,
  };
  // One node the IR reaches from two statements is wrapped once.
  const use: IrStmt = { kind: "exprStmt", expr: first, loc };
  const functions = [
    fn(ENTRY_NAME, [use, use]),
    fn("helper", [{ kind: "exprStmt", expr: resolve, loc }]),
  ];
  adoptIslandThenables({ usesNodeIsland: true } as unknown as Lowerer, functions);
  expect(first.args[0]).toMatchObject({
    kind: "libCall",
    fn: "nodeIsland.adoptThenable",
    args: [{ kind: "varRef", localId: "%v" }],
  });
  expect(resolve.args[0]).toMatchObject({ kind: "libCall", fn: "nodeIsland.adoptThenable" });
  // The then-reader argument of PromiseResolve is left as it is.
  expect(resolve.args[1]).toMatchObject({ kind: "varRef" });
});

test("a program with Node islands resolves a dynamic Promise.resolve through the runtime", () => {
  const promiseOfDyn = { kind: "promise", inner: DYN } as const;
  const resolve = {
    kind: "intrinsic",
    name: "promise.resolve",
    args: [operand()],
    type: promiseOfDyn,
    loc,
  } as IrExpr;
  // A promise of nothing, or of a typed value, is never a thenable's.
  const empty = { kind: "intrinsic", name: "promise.resolve", args: [], type: promiseOfDyn, loc };
  const withResolve = fn(ENTRY_NAME, [
    { kind: "exprStmt", expr: resolve, loc },
    { kind: "exprStmt", expr: empty as IrExpr, loc },
  ]);
  const untouched = fn("helper", [{ kind: "exprStmt", expr: empty as IrExpr, loc }]);
  const untouchedBody = untouched.body;
  adoptIslandThenables({ usesNodeIsland: true } as unknown as Lowerer, [withResolve, untouched]);
  expect(withResolve.body).toEqual([
    {
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "nodeIsland.promiseResolve",
        args: [{ kind: "varRef", localId: "%v", type: DYN, loc }],
        type: promiseOfDyn,
        loc,
      },
      loc,
    },
    { kind: "exprStmt", expr: empty, loc },
  ]);
  // The rewrite makes new nodes: the node it replaced is as it was, and a
  // function without one keeps its body.
  expect(resolve).toMatchObject({ kind: "intrinsic", name: "promise.resolve" });
  expect(untouched.body).toBe(untouchedBody);
  const kept = fn(ENTRY_NAME, [{ kind: "exprStmt", expr: resolve, loc }]);
  adoptIslandThenables({ usesNodeIsland: false } as unknown as Lowerer, [kept]);
  expect(kept.body[0]).toMatchObject({ expr: { kind: "intrinsic", name: "promise.resolve" } });
});

test("a program without Node islands keeps the plain dynamic await", () => {
  const call = awaitDyn();
  adoptIslandThenables({ usesNodeIsland: false } as unknown as Lowerer, [
    fn(ENTRY_NAME, [{ kind: "exprStmt", expr: call, loc }]),
  ]);
  expect(call.args[0]).toMatchObject({ kind: "varRef" });
});
