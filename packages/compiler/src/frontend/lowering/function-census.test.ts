import { expect, test } from "vitest";
import { BOOL, F64, STRING, type IrExpr, type IrFunction, type IrStmt } from "../../ir/ir.js";
import { FunctionCensus } from "./function-census.js";

const loc = { file: "census.ts", start: 0, end: 1 };

function fnOf(body: IrStmt[], name = "f"): IrFunction {
  return { name, params: [], locals: [], returnType: BOOL, loc, body };
}

const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const ret = (value: IrExpr): IrStmt => ({ kind: "return", value, loc });
/** A `libCall` entry point name, as the IR declares it. */
type LibFn = Extract<IrExpr, { kind: "libCall" }>["fn"];

const call = (fn: LibFn): IrStmt => ({
  kind: "exprStmt",
  expr: { kind: "libCall", fn, args: [], type: F64, loc },
  loc,
});

const log: IrStmt = {
  kind: "exprStmt",
  expr: { kind: "intrinsic", name: "console.log", args: [num(1)], type: F64, loc },
  loc,
};

test("the facts name the kinds, library entry points, and intrinsics of the body", () => {
  const fn = fnOf([
    call("number.isFinite"),
    log,
    {
      kind: "if",
      cond: { kind: "varRef", localId: "flag", type: BOOL, loc },
      then: [ret(num(1))],
      else_: null,
      loc,
    },
  ]);
  const census = new FunctionCensus();
  expect(census.hasExpr(fn, "varRef")).toBe(true);
  expect(census.hasExpr(fn, "numLit")).toBe(true);
  expect(census.hasExpr(fn, "strLit")).toBe(false);
  expect(census.hasStmt(fn, "if")).toBe(true);
  expect(census.hasStmt(fn, "while")).toBe(false);
  expect(census.hasLibFn(fn, "number.isFinite")).toBe(true);
  expect(census.hasLibFn(fn, "number.isInteger")).toBe(false);
  expect(census.hasAnyLibFn(fn, new Set(["number.isInteger", "number.isFinite"]))).toBe(true);
  expect(census.hasAnyIntrinsic(fn, ["console.error", "console.log"])).toBe(true);
  expect(census.hasAnyIntrinsic(fn, ["promise.all"])).toBe(false);
  expect(census.hasAnyExpr(fn, ["strLit", "numLit"])).toBe(true);
});

test("a body replaced by a new statement list is scanned again", () => {
  const fn = fnOf([ret(num(1))]);
  const census = new FunctionCensus();
  expect(census.hasExpr(fn, "strLit")).toBe(false);
  fn.body = [{ kind: "return", value: { kind: "strLit", value: "x", type: STRING, loc }, loc }];
  expect(census.hasExpr(fn, "strLit")).toBe(true);
  expect(census.hasExpr(fn, "numLit")).toBe(false);
});

test("a node changed inside an unchanged list keeps its old facts until forget", () => {
  // Three statements, so replacing what is not the first or the last one
  // leaves the list the census validates on.
  const fn = fnOf([ret(num(1)), call("number.isFinite"), ret(num(3))]);
  const census = new FunctionCensus();
  expect(census.hasExpr(fn, "dynFrom")).toBe(false);
  const middle = fn.body[1] as Extract<IrStmt, { kind: "exprStmt" }>;
  middle.expr = { kind: "dynFrom", value: num(2), type: F64, loc };
  expect(census.hasExpr(fn, "dynFrom")).toBe(false);
  census.forget(fn);
  expect(census.hasExpr(fn, "dynFrom")).toBe(true);
  expect(census.hasExpr(fn, "libCall")).toBe(false);
});

test("clear drops every census, for a pass that rewrites nodes in place", () => {
  const first = fnOf([ret(num(1)), call("number.isFinite"), ret(num(3))], "first");
  const second = fnOf([ret(num(4)), call("number.isFinite"), ret(num(5))], "second");
  const census = new FunctionCensus();
  expect(census.hasExpr(first, "strLit")).toBe(false);
  expect(census.hasExpr(second, "strLit")).toBe(false);
  for (const fn of [first, second]) {
    const middle = fn.body[1] as Extract<IrStmt, { kind: "exprStmt" }>;
    middle.expr = { kind: "strLit", value: "x", type: STRING, loc };
  }
  expect(census.hasExpr(first, "strLit")).toBe(false);
  census.clear();
  expect(census.hasExpr(first, "strLit")).toBe(true);
  expect(census.hasExpr(second, "strLit")).toBe(true);
});
