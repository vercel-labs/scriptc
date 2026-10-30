import { expect, test } from "vitest";
import {
  BOOL,
  F64,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrModule,
  type IrStmt,
} from "../../ir/ir.js";
import { findLoopCallees } from "./loop-callees.js";

const loc = { file: "callees.ts", start: 0, end: 0 };
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const ref = (localId: string): IrExpr => ({ kind: "varRef", localId, type: F64, loc });
const call = (callee: string): IrExpr => ({ kind: "call", callee, args: [num(1)], type: F64, loc });
const run = (e: IrExpr): IrStmt => ({ kind: "exprStmt", expr: e, loc });
const ret = (e: IrExpr): IrStmt => ({ kind: "return", value: e, loc });
const loop = (body: IrStmt[]): IrStmt => ({
  kind: "while",
  cond: { kind: "bin", op: "<", left: ref("i"), right: num(10), type: BOOL, loc },
  body,
  loc,
});
const fn = (name: string, body: IrStmt[], extra: Partial<IrFunction> = {}): IrFunction => ({
  name,
  params: [{ localId: "x", name: "x", type: F64 }],
  returnType: F64,
  locals: [{ id: "x", name: "x", type: F64, mutable: false }],
  body,
  loc,
  ...extra,
});
const module = (functions: IrFunction[]): IrModule => ({
  irVersion: 17,
  sourceFile: loc.file,
  entry: "__main",
  functions: [
    { name: "__main", params: [], returnType: VOID, locals: [], body: [], loc },
    ...functions,
  ],
});

test("a small leaf called only from loops is a loop callee", () => {
  const callees = findLoopCallees(
    module([
      fn("leaf", [loop([run(ref("x"))]), ret(ref("x"))]),
      fn("caller", [loop([run(call("leaf"))]), loop([run(call("leaf"))]), ret(num(0))]),
    ]),
  );
  expect([...callees]).toEqual(["leaf"]);
});

test("a call outside a loop, a third call site, an own call or a large body keeps the call", () => {
  const leaf = fn("leaf", [ret(ref("x"))]);
  // A call site outside any loop.
  expect(
    findLoopCallees(module([leaf, fn("caller", [run(call("leaf")), loop([run(call("leaf"))])])]))
      .size,
  ).toBe(0);
  // Three call sites.
  const three = fn("caller", [loop([run(call("leaf")), run(call("leaf")), run(call("leaf"))])]);
  expect(findLoopCallees(module([leaf, three])).size).toBe(0);
  // A callee that calls another function.
  const calling = fn("calling", [ret(call("leaf"))]);
  const caller = fn("caller", [loop([run(call("calling"))])]);
  // (leaf is then called outside a loop, from calling.)
  expect(findLoopCallees(module([leaf, calling, caller])).size).toBe(0);
  // Two loops, or more than 12 statements.
  const twoLoops = fn("leaf", [loop([]), loop([]), ret(ref("x"))]);
  expect(findLoopCallees(module([twoLoops, fn("caller", [loop([run(call("leaf"))])])])).size).toBe(
    0,
  );
  const long = fn("leaf", [...Array.from({ length: 12 }, () => run(ref("x"))), ret(ref("x"))]);
  expect(findLoopCallees(module([long, fn("caller", [loop([run(call("leaf"))])])])).size).toBe(0);
  // Async functions and library modules.
  const asyncLeaf = fn("leaf", [ret(ref("x"))], { async: true });
  expect(findLoopCallees(module([asyncLeaf, fn("caller", [loop([run(call("leaf"))])])])).size).toBe(
    0,
  );
  const lib = { ...module([leaf, fn("caller", [loop([run(call("leaf"))])])]), lib: {} } as IrModule;
  expect(findLoopCallees(lib).size).toBe(0);
});
