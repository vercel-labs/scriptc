import { expect, test } from "vitest";
import { specializeConstantArrayLengths } from "./constant-length-clones.js";
import {
  BOOL,
  F64,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrModule,
  type IrParam,
  type IrStmt,
  type IrType,
} from "./ir.js";

const loc = { file: "constant-length-clones.ts", start: 0, end: 0 };
const num = (value: number): IrExpr => ({
  loc,
  kind: "numLit",
  value,
  type: F64,
});
const ref = (localId: string, type: IrType = F64): IrExpr => ({
  loc,
  kind: "varRef",
  localId,
  type,
});
const ARR: IrType = { kind: "array", elem: F64 };
const arrayOf = (length: number): IrExpr => ({
  loc,
  kind: "arrayLit",
  elems: Array.from({ length }, (_unused, index) => num(index)),
  type: ARR,
});
const length = (receiver: IrExpr): IrExpr => ({
  loc,
  kind: "arrIntrinsic",
  method: "length",
  receiver,
  args: [],
  type: F64,
});
const bin = (op: Extract<IrExpr, { kind: "bin" }>["op"], left: IrExpr, right: IrExpr): IrExpr => ({
  loc,
  kind: "bin",
  op,
  left,
  right,
  type: op === "<" ? BOOL : F64,
});
/** The statements wrapped in a loop, the position a specializing call sits in. */
const loop = (body: IrStmt[]): IrStmt => ({
  loc,
  kind: "while",
  cond: bin("<", num(0), num(1)),
  body,
});
const ret = (value: IrExpr): IrStmt => ({ loc, kind: "return", value });
const decl = (localId: string, init: IrExpr | null): IrStmt => ({
  loc,
  kind: "varDecl",
  localId,
  init,
});
const assign = (localId: string, value: IrExpr): IrStmt => ({
  loc,
  kind: "assign",
  localId,
  value,
});
const param = (localId: string): IrParam => ({
  localId,
  name: localId,
  type: ARR,
});
const localOf = (id: string, type: IrType = F64, extra: Partial<IrLocal> = {}): IrLocal => ({
  id,
  name: id,
  type,
  mutable: false,
  ...extra,
});
const fn = (
  name: string,
  params: IrParam[],
  locals: IrLocal[],
  body: IrStmt[],
  extra: Partial<IrFunction> = {},
): IrFunction => ({
  loc,
  name,
  params,
  locals,
  returnType: VOID,
  body,
  ...extra,
});
const arrayGlobal = (id: string, extra: object = {}) => ({
  id,
  name: id,
  type: ARR,
  mutable: false,
  ...extra,
});

/** A callee that reads its parameter's element count into a local, indexes it
 * and returns the count. */
function reader(extra: IrStmt[] = [], extra2: Partial<IrFunction> = {}): IrFunction {
  return fn(
    "reader",
    [param("a.0")],
    [localOf("n.0"), localOf("i.0")],
    [decl("n.0", length(ref("a.0", ARR))), decl("i.0", num(0)), ...extra, ret(ref("n.0"))],
    extra2,
  );
}

function moduleWith(functions: IrFunction[], globals: IrModule["globals"] = []): IrModule {
  return {
    irVersion: 17,
    sourceFile: "constant-length-clones.ts",
    entry: "%init",
    functions,
    globals,
  };
}

const init = (body: IrStmt[]): IrFunction => fn("%init", [], [], body);

test("a looping call passing an immutable array literal global specializes the callee", () => {
  const mod = moduleWith(
    [
      init([
        loop([
          assign("caller.0", {
            loc,
            kind: "call",
            callee: "reader",
            args: [ref("%g.e.arr", ARR)],
            type: F64,
          }),
        ]),
      ]),
      reader(),
    ],
    [arrayGlobal("%g.e.arr")],
  );
  mod.functions[0]!.body.unshift(assign("%g.e.arr", arrayOf(3)));
  const out = specializeConstantArrayLengths(mod);
  const clone = out.functions.find((candidate) => candidate.name === "reader.constLen");
  expect(clone).toBeDefined();
  expect(clone!.params[0]!.constLength).toBe(3);
  const text = JSON.stringify(clone!.body);
  expect(text).not.toContain('"method":"length"');
  expect(text).toContain('"value":3');
  const call = JSON.stringify(out.functions[0]!.body);
  expect(call).toContain('"callee":"reader.constLen"');
  // The original function keeps its runtime read.
  expect(JSON.stringify(out.functions[1]!.body)).toContain('"method":"length"');
});

test("a looping call passing a constant local in the caller specializes the callee", () => {
  const mod = moduleWith([
    fn(
      "%init",
      [],
      [localOf("arr.0", ARR)],
      [
        decl("arr.0", arrayOf(4)),
        loop([
          assign("caller.0", {
            loc,
            kind: "call",
            callee: "reader",
            args: [ref("arr.0", ARR)],
            type: F64,
          }),
        ]),
      ],
    ),
    reader(),
  ]);
  const out = specializeConstantArrayLengths(mod);
  const clone = out.functions.find((candidate) => candidate.name === "reader.constLen");
  expect(clone?.params[0]?.constLength).toBe(4);
});

test("a call outside any loop keeps the general callee", () => {
  const mod = moduleWith(
    [
      init([
        assign("caller.0", {
          loc,
          kind: "call",
          callee: "reader",
          args: [ref("%g.e.arr", ARR)],
          type: F64,
        }),
      ]),
      reader(),
    ],
    [arrayGlobal("%g.e.arr")],
  );
  mod.functions[0]!.body.unshift(assign("%g.e.arr", arrayOf(3)));
  const out = specializeConstantArrayLengths(mod);
  expect(out.functions.map((candidate) => candidate.name)).toEqual(["%init", "reader"]);
  expect(JSON.stringify(out.functions[0]!.body)).toContain('"callee":"reader"');
  expect(JSON.stringify(out.functions[1]!.body)).toContain('"method":"length"');
});

test("a callee that grows its parameter keeps the original function", () => {
  const push: IrStmt = {
    loc,
    kind: "exprStmt",
    expr: {
      loc,
      kind: "arrIntrinsic",
      method: "push",
      receiver: ref("a.0", ARR),
      args: [num(1)],
      type: F64,
    },
  };
  const mod = moduleWith(
    [
      init([
        assign("caller.0", {
          loc,
          kind: "call",
          callee: "reader",
          args: [ref("%g.e.arr", ARR)],
          type: F64,
        }),
      ]),
      reader([push]),
    ],
    [arrayGlobal("%g.e.arr")],
  );
  mod.functions[0]!.body.unshift(assign("%g.e.arr", arrayOf(3)));
  const out = specializeConstantArrayLengths(mod);
  expect(out.functions.map((candidate) => candidate.name)).toEqual(["%init", "reader"]);
});

test("a callee that returns its parameter keeps the original function", () => {
  const mod = moduleWith(
    [
      init([
        assign("caller.0", {
          loc,
          kind: "call",
          callee: "reader",
          args: [ref("%g.e.arr", ARR)],
          type: F64,
        }),
      ]),
      reader([{ loc, kind: "exprStmt", expr: ref("a.0", ARR) }]),
    ],
    [arrayGlobal("%g.e.arr")],
  );
  mod.functions[0]!.body.unshift(assign("%g.e.arr", arrayOf(3)));
  const out = specializeConstantArrayLengths(mod);
  expect(out.functions.map((candidate) => candidate.name)).toEqual(["%init", "reader"]);
});

test("an argument array written twice does not specialize", () => {
  const mod = moduleWith(
    [
      init([
        assign("%g.e.arr", arrayOf(3)),
        assign("%g.e.arr", arrayOf(3)),
        assign("caller.0", {
          loc,
          kind: "call",
          callee: "reader",
          args: [ref("%g.e.arr", ARR)],
          type: F64,
        }),
      ]),
      reader(),
    ],
    [arrayGlobal("%g.e.arr")],
  );
  const out = specializeConstantArrayLengths(mod);
  expect(out.functions.map((candidate) => candidate.name)).toEqual(["%init", "reader"]);
});

test("an argument array that is not a literal does not specialize", () => {
  const mod = moduleWith(
    [
      init([
        decl("arr.0", { loc, kind: "arrayNewLen", length: num(3), type: ARR }),
        assign("caller.0", {
          loc,
          kind: "call",
          callee: "reader",
          args: [ref("arr.0", ARR)],
          type: F64,
        }),
      ]),
      reader(),
    ],
    [],
  );
  const out = specializeConstantArrayLengths(mod);
  expect(out.functions.map((candidate) => candidate.name)).toEqual(["%init", "reader"]);
});

test("an argument array passed on to a callee that grows it does not specialize", () => {
  const grow = fn(
    "grow",
    [param("b.0")],
    [],
    [
      {
        loc,
        kind: "exprStmt",
        expr: {
          loc,
          kind: "arrIntrinsic",
          method: "push",
          receiver: ref("b.0", ARR),
          args: [num(1)],
          type: F64,
        },
      },
    ],
  );
  const mod = moduleWith(
    [
      init([
        assign("%g.e.arr", arrayOf(3)),
        loop([
          assign("caller.0", {
            loc,
            kind: "call",
            callee: "grow",
            args: [ref("%g.e.arr", ARR)],
            type: VOID,
          }),
          assign("caller.1", {
            loc,
            kind: "call",
            callee: "reader",
            args: [ref("%g.e.arr", ARR)],
            type: F64,
          }),
        ]),
      ]),
      grow,
      reader(),
    ],
    [arrayGlobal("%g.e.arr")],
  );
  const out = specializeConstantArrayLengths(mod);
  expect(out.functions.map((candidate) => candidate.name)).toEqual(["%init", "grow", "reader"]);
});

/** `arr.push(1)` on a binding. */
const push = (localId: string): IrStmt => ({
  loc,
  kind: "exprStmt",
  expr: {
    loc,
    kind: "arrIntrinsic",
    method: "push",
    receiver: ref(localId, ARR),
    args: [num(1)],
    type: F64,
  },
});
/** `caller.0 = reader(<global>)` in a loop. */
const loopingRead = (global: string): IrStmt =>
  loop([
    assign("caller.0", {
      loc,
      kind: "call",
      callee: "reader",
      args: [ref(global, ARR)],
      type: F64,
    }),
  ]);

test("a global that a function elsewhere in the module grows does not specialize", () => {
  const mod = moduleWith(
    [
      init([assign("%g.e.arr", arrayOf(3)), loopingRead("%g.e.arr")]),
      reader(),
      fn("bystander", [], [localOf("x.0")], [decl("x.0", num(1))]),
      fn("grower", [], [], [push("%g.e.arr")]),
    ],
    [arrayGlobal("%g.e.arr")],
  );
  const out = specializeConstantArrayLengths(mod);
  expect(out.functions.map((candidate) => candidate.name)).toEqual([
    "%init",
    "reader",
    "bystander",
    "grower",
  ]);
});

test("a global that a function elsewhere in the module writes again does not specialize", () => {
  const mod = moduleWith(
    [
      init([assign("%g.e.arr", arrayOf(3)), loopingRead("%g.e.arr")]),
      reader(),
      fn("rewriter", [], [], [assign("%g.e.arr", arrayOf(3))]),
    ],
    [arrayGlobal("%g.e.arr")],
  );
  const out = specializeConstantArrayLengths(mod);
  expect(out.functions.map((candidate) => candidate.name)).toEqual(["%init", "reader", "rewriter"]);
});

test("each global is judged by the functions that name it", () => {
  // Two globals in one module: the functions that only read one of them, or
  // neither, do not stop the other from specializing, and the one a function
  // grows keeps the general callee.
  const mod = moduleWith(
    [
      init([
        assign("%g.e.three", arrayOf(3)),
        assign("%g.e.grown", arrayOf(4)),
        loopingRead("%g.e.three"),
        loopingRead("%g.e.grown"),
      ]),
      reader(),
      fn("bystander", [], [localOf("x.0")], [decl("x.0", num(1))]),
      fn("looker", [], [localOf("n.1")], [decl("n.1", length(ref("%g.e.three", ARR)))]),
      fn("grower", [], [], [push("%g.e.grown")]),
    ],
    [arrayGlobal("%g.e.three"), arrayGlobal("%g.e.grown")],
  );
  const out = specializeConstantArrayLengths(mod);
  const clones = out.functions.filter((candidate) => candidate.name.startsWith("reader.constLen"));
  expect(clones.map((clone) => clone.params[0]!.constLength)).toEqual([3]);
  const calls = JSON.stringify(out.functions[0]!.body);
  expect(calls.match(/"callee":"reader\.constLen"/g)).toHaveLength(1);
  expect(calls.match(/"callee":"reader"/g)).toHaveLength(1);
});
