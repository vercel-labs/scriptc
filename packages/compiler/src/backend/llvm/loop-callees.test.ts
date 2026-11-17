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

const callees = (functions: IrFunction[]): string[] => [
  ...findLoopCallees(module(functions)).callees,
];
const bodyCalls = (functions: IrFunction[]): [string, string[]][] =>
  [...findLoopCallees(module(functions)).bodyCalls].map(([name, called]) => [name, [...called]]);

test("a small leaf called only from loops is a loop callee", () => {
  expect(
    callees([
      fn("leaf", [loop([run(ref("x"))]), ret(ref("x"))]),
      fn("caller", [loop([run(call("leaf"))]), loop([run(call("leaf"))]), ret(num(0))]),
    ]),
  ).toEqual(["leaf"]);
});

test("a wrapper called only from loops takes the bodies it calls with it", () => {
  const leaf = fn("leaf", [ret(ref("x"))]);
  const wrapper = fn("calling", [run(call("leaf")), ret(call("leaf"))]);
  const caller = fn("caller", [loop([run(call("calling"))])]);
  // The wrapper's call is marked; its leaf's own sites stay out of line (the
  // one that matters moves into the loop with the wrapper).
  expect(callees([leaf, wrapper, caller])).toEqual(["calling"]);
  expect(bodyCalls([leaf, wrapper, caller])).toEqual([["calling", ["leaf"]]]);
});

test("a chain of small bodies inlines as one, up to the depth limit", () => {
  const leaf = fn("leaf", [ret(ref("x"))]);
  const put = fn("put", [run(call("leaf")), ret(ref("x"))]);
  const base = fn("base", [run(call("put")), ret(ref("x"))]);
  const caller = fn("caller", [loop([run(call("base"))]), ret(num(0))]);
  expect(callees([leaf, put, base, caller])).toEqual(["base"]);
  expect(bodyCalls([leaf, put, base, caller])).toEqual([
    ["base", ["put"]],
    ["put", ["leaf"]],
  ]);
  // A chain of four bodies reaches the leaf; a fifth link is past
  // MAX_INLINE_DEPTH.
  const deeper = fn("deeper", [ret(call("base"))]);
  const loop3 = fn("caller", [loop([run(call("deeper"))]), ret(num(0))]);
  expect(callees([leaf, put, base, deeper, loop3])).toEqual(["deeper"]);
  expect(bodyCalls([leaf, put, base, deeper, loop3])).toEqual([
    ["deeper", ["base"]],
    ["base", ["put"]],
    ["put", ["leaf"]],
  ]);
  const deepest = fn("deepest", [ret(call("deeper"))]);
  const beyond = fn("caller", [loop([run(call("deepest"))]), ret(num(0))]);
  expect(callees([leaf, put, base, deeper, deepest, beyond])).toEqual([]);
  expect(bodyCalls([leaf, put, base, deeper, deepest, beyond])).toEqual([]);
});

test("a call outside a loop, a third call site, an own call or a large body keeps the call", () => {
  const leaf = fn("leaf", [ret(ref("x"))]);
  // A call site outside any loop.
  expect(callees([leaf, fn("caller", [run(call("leaf")), loop([run(call("leaf"))])])])).toEqual([]);
  // Three call sites.
  const three = fn("caller", [loop([run(call("leaf")), run(call("leaf")), run(call("leaf"))])]);
  expect(callees([leaf, three])).toEqual([]);
  // A wrapper with a call site outside any loop.
  const wrapper = fn("calling", [ret(call("leaf"))]);
  expect(
    callees([leaf, wrapper, fn("caller", [run(call("calling")), loop([run(call("calling"))])])]),
  ).toEqual([]);
  expect(
    bodyCalls([leaf, wrapper, fn("caller", [run(call("calling")), loop([run(call("calling"))])])]),
  ).toEqual([]);
  // Recursion and mutual recursion never join the chain.
  const self = fn("self", [run(call("self")), ret(call("leaf"))]);
  expect(callees([leaf, self, fn("caller", [loop([run(call("self"))])])])).toEqual([]);
  const ping = fn("ping", [ret(call("pong"))]);
  const pong = fn("pong", [ret(call("ping"))]);
  expect(callees([leaf, ping, pong, fn("caller", [loop([run(call("ping"))])])])).toEqual([]);
  // Two loops, or more than 12 statements.
  const twoLoops = fn("leaf", [loop([]), loop([]), ret(ref("x"))]);
  expect(callees([twoLoops, fn("caller", [loop([run(call("leaf"))])])])).toEqual([]);
  const long = fn("leaf", [...Array.from({ length: 12 }, () => run(ref("x"))), ret(ref("x"))]);
  expect(callees([long, fn("caller", [loop([run(call("leaf"))])])])).toEqual([]);
  // Async functions and library modules.
  const asyncLeaf = fn("leaf", [ret(ref("x"))], { async: true });
  expect(callees([asyncLeaf, fn("caller", [loop([run(call("leaf"))])])])).toEqual([]);
  const lib = {
    ...module([leaf, fn("caller", [loop([run(call("leaf"))])])]),
    lib: {},
  } as IrModule;
  expect(findLoopCallees(lib).callees.size).toBe(0);
  expect(findLoopCallees(lib).bodyCalls.size).toBe(0);
});
