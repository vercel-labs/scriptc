import { expect, test } from "vitest";
import { inlineExpressionFunctions } from "./expression-inlining.js";
import { BOOL, F64, VOID, type IrExpr, type IrFunction, type IrModule, type IrStmt } from "./ir.js";

const loc = { file: "expression-inlining.ts", start: 0, end: 0 };
const num = (value: number): IrExpr => ({ loc, kind: "numLit", value, type: F64 });
const ref = (localId: string): IrExpr => ({ loc, kind: "varRef", localId, type: F64 });
const bin = (op: "+" | "*" | ">>>", left: IrExpr, right: IrExpr): IrExpr => ({
  loc,
  kind: "bin",
  op,
  left,
  right,
  type: F64,
});
const call = (callee: string, args: IrExpr[]): IrExpr => ({
  loc,
  kind: "call",
  callee,
  args,
  type: F64,
});
const local = (id: string, extra: object = {}) => ({
  id,
  name: id,
  type: F64,
  mutable: true,
  ...extra,
});

// a(i, j) = ((i + j) * (i + j + 1)) >>> 1
const a: IrFunction = {
  loc,
  name: "a",
  params: [
    { localId: "i", name: "i", type: F64 },
    { localId: "j", name: "j", type: F64 },
  ],
  locals: [local("i"), local("j")],
  returnType: F64,
  body: [
    {
      loc,
      kind: "return",
      value: bin(
        ">>>",
        bin("*", bin("+", ref("i"), ref("j")), bin("+", bin("+", ref("i"), ref("j")), num(1))),
        num(1),
      ),
    },
  ],
};

/** `caller` running `body` in a loop. */
function caller(body: IrStmt[], extra: object = {}): IrFunction {
  return {
    loc,
    name: "caller",
    params: [],
    locals: [local("x", extra), local("y"), local("out")],
    returnType: VOID,
    body: [{ loc, kind: "while", cond: { loc, kind: "boolLit", value: true, type: BOOL }, body }],
  };
}

const loopBody = (fn: IrFunction): IrStmt[] => (fn.body[0] as IrStmt & { kind: "while" }).body;

const mod = (fn: IrFunction): IrModule => ({
  irVersion: 17,
  sourceFile: "expression-inlining.ts",
  entry: "caller",
  functions: [a, fn],
});

test("calls passing literals and locals take the callee's expression over them", () => {
  const result = inlineExpressionFunctions(
    mod(caller([{ loc, kind: "assign", localId: "out", value: call("a", [ref("x"), num(3)]) }])),
  );
  const assign = loopBody(result.functions[1]!)[0] as IrStmt & { kind: "assign" };
  expect(assign.value).toMatchObject({
    kind: "bin",
    op: ">>>",
    left: {
      kind: "bin",
      op: "*",
      left: {
        kind: "bin",
        op: "+",
        left: { kind: "varRef", localId: "x" },
        right: { kind: "numLit", value: 3 },
      },
    },
  });
  // Every substituted read is a fresh node.
  const left = (assign.value as IrExpr & { kind: "bin" }).left as IrExpr & { kind: "bin" };
  const factors = [left.left, (left.right as IrExpr & { kind: "bin" }).left] as (IrExpr & {
    kind: "bin";
  })[];
  expect(factors[0]!.left).not.toBe(factors[1]!.left);
  expect(result.functions[0]).toBe(a);
});

test("calls with other arguments, boxed locals or callees with other bodies keep their call", () => {
  const nested = call("a", [call("a", [ref("x"), ref("y")]), num(1)]);
  const kept = inlineExpressionFunctions(
    mod(caller([{ loc, kind: "assign", localId: "out", value: nested }])),
  );
  const outer = (loopBody(kept.functions[1]!)[0] as IrStmt & { kind: "assign" }).value;
  // The inner call inlines; the outer one passes a computed argument.
  expect(outer).toMatchObject({
    kind: "call",
    callee: "a",
    args: [{ kind: "bin", op: ">>>" }, { kind: "numLit" }],
  });
  const boxed = caller(
    [{ loc, kind: "assign", localId: "out", value: call("a", [ref("x"), ref("y")]) }],
    {
      boxed: true,
    },
  );
  expect(inlineExpressionFunctions(mod(boxed)).functions[1]).toBe(boxed);
  const twoStatements: IrFunction = {
    ...a,
    body: [{ loc, kind: "exprStmt", expr: ref("i") }, ...a.body],
  };
  const unchanged: IrModule = {
    ...mod(
      caller([{ loc, kind: "assign", localId: "out", value: call("a", [ref("x"), ref("y")]) }]),
    ),
    functions: [
      twoStatements,
      caller([{ loc, kind: "assign", localId: "out", value: call("a", [ref("x"), ref("y")]) }]),
    ],
  };
  expect(inlineExpressionFunctions(unchanged)).toBe(unchanged);
});

test("calls outside loops keep their call", () => {
  const outside: IrFunction = {
    ...caller([]),
    body: [{ loc, kind: "assign", localId: "out", value: call("a", [ref("x"), num(3)]) }],
  };
  const m = mod(outside);
  expect(inlineExpressionFunctions(m)).toBe(m);
});
