import { expect, test } from "vitest";
import { BOOL, F64, STRING, VOID, type IrExpr, type IrFunction, type IrStmt } from "../../ir/ir.js";
import { analyzeCallLifetimes } from "./call-lifetimes.js";
import {
  findLentStringParameters,
  findScalarStringSlices,
  findScratchStringSlices,
} from "./string-slices.js";
const loc = { file: "slices.ts", start: 0, end: 0 };
const ref = (id: string): IrExpr => ({ kind: "varRef", localId: id, type: STRING, loc });
function fixture(): IrFunction {
  return {
    name: "scan",
    params: [{ localId: "source", name: "source", type: STRING }],
    locals: [
      { id: "source", name: "source", type: STRING, mutable: true },
      { id: "piece", name: "piece", type: STRING, mutable: true },
    ],
    returnType: VOID,
    loc,
    body: [
      {
        kind: "varDecl",
        localId: "piece",
        init: {
          kind: "strIntrinsic",
          method: "substring",
          receiver: ref("source"),
          args: [{ kind: "numLit", value: 1, type: F64, loc }],
          type: STRING,
          loc,
        },
        loc,
      },
      {
        kind: "exprStmt",
        expr: {
          kind: "strIntrinsic",
          method: "length",
          receiver: ref("piece"),
          args: [],
          type: F64,
          loc,
        },
        loc,
      },
      {
        kind: "exprStmt",
        expr: {
          kind: "strIntrinsic",
          method: "charCodeAt",
          receiver: ref("piece"),
          args: [{ kind: "numLit", value: 0, type: F64, loc }],
          type: F64,
          loc,
        },
        loc,
      },
    ],
  };
}
function facts(fn: IrFunction) {
  return findScalarStringSlices(fn, analyzeCallLifetimes(new Map([[fn.name, fn]])));
}
test("stable scalar-only slices keep their source and bounds instead of copied bytes", () => {
  const fn = fixture();
  expect([...facts(fn).keys()]).toEqual(["piece"]);
  fn.body.push({
    kind: "assign",
    localId: "source",
    value: { kind: "strLit", value: "new", type: STRING, loc },
    loc,
  });
  expect([...facts(fn).keys()]).toEqual(["piece"]);
});
test.each(["escape", "capture", "write", "other-consumer", "suspend"])(
  "%s needs a materialized string",
  (reason) => {
    const fn = fixture();
    const stmt: IrStmt = { kind: "return", value: ref("piece"), loc };
    if (reason === "escape") fn.body.push(stmt);
    if (reason === "capture") fn.locals[1]!.boxed = true;
    if (reason === "write")
      fn.body.push({ kind: "assign", localId: "piece", value: ref("source"), loc });
    if (reason === "other-consumer")
      fn.body.push({
        kind: "exprStmt",
        expr: {
          kind: "strIntrinsic",
          method: "trim",
          receiver: ref("piece"),
          args: [],
          type: STRING,
          loc,
        },
        loc,
      });
    if (reason === "suspend") fn.async = true;
    expect(facts(fn).size).toBe(0);
  },
);

const slice = (receiver: string, start: number, end: number): IrExpr => ({
  kind: "strIntrinsic",
  method: "slice",
  receiver: ref(receiver),
  args: [
    { kind: "numLit", value: start, type: F64, loc },
    { kind: "numLit", value: end, type: F64, loc },
  ],
  type: STRING,
  loc,
});
const equals = (left: IrExpr): IrExpr => ({
  kind: "strEq",
  negated: false,
  left,
  right: { kind: "strLit", value: "GET", type: STRING, loc },
  type: BOOL,
  loc,
});
const parse = (value: IrExpr): IrExpr => ({
  kind: "libCall",
  fn: "num.fromString",
  args: [value],
  type: F64,
  loc,
});
function lending(body: IrStmt[]): IrFunction {
  return {
    name: "scan",
    params: [{ localId: "source", name: "source", type: STRING }],
    locals: [
      { id: "source", name: "source", type: STRING, mutable: false },
      { id: "word", name: "word", type: STRING, mutable: false },
    ],
    returnType: VOID,
    loc,
    body,
  };
}
function scratch(fn: IrFunction, extra: IrFunction[] = []): Set<IrExpr> {
  const functions = new Map([fn, ...extra].map((f) => [f.name, f]));
  const lifetimes = analyzeCallLifetimes(functions);
  return findScratchStringSlices(
    fn,
    lifetimes,
    findScalarStringSlices(fn, lifetimes),
    findLentStringParameters(functions, lifetimes),
  );
}
test("slices read only by lending consumers use a stack buffer", () => {
  const inline = slice("source", 0, 3);
  const parsed = slice("source", 4, 6);
  const init = slice("source", 1, 5);
  const fn = lending([
    { kind: "exprStmt", expr: equals(inline), loc },
    { kind: "exprStmt", expr: parse(parsed), loc },
    { kind: "varDecl", localId: "word", init, loc },
    { kind: "exprStmt", expr: equals(ref("word")), loc },
    { kind: "exprStmt", expr: parse(ref("word")), loc },
  ]);
  expect(scratch(fn)).toEqual(new Set([inline, parsed, init]));
});
test.each(["return", "concat", "slice-of-slice", "capture", "async"])(
  "a slice local that may be kept (%s) stays owned",
  (reason) => {
    const init = slice("source", 1, 5);
    const fn = lending([
      { kind: "varDecl", localId: "word", init, loc },
      { kind: "exprStmt", expr: equals(ref("word")), loc },
    ]);
    if (reason === "return") fn.body.push({ kind: "return", value: ref("word"), loc });
    if (reason === "concat")
      fn.body.push({
        kind: "exprStmt",
        expr: {
          kind: "strConcat",
          left: { kind: "strLit", value: "", type: STRING, loc },
          right: ref("word"),
          type: STRING,
          loc,
        },
        loc,
      });
    if (reason === "slice-of-slice")
      fn.body.push({ kind: "exprStmt", expr: equals(slice("word", 0, 2)), loc });
    if (reason === "capture") fn.locals[1]!.boxed = true;
    if (reason === "async") fn.async = true;
    expect(scratch(fn).has(init)).toBe(false);
  },
);
function helper(name: string, body: IrStmt[]): IrFunction {
  return {
    name,
    params: [{ localId: "text", name: "text", type: STRING }],
    locals: [{ id: "text", name: "text", type: STRING, mutable: false }],
    returnType: BOOL,
    loc,
    body,
  };
}
const callOf = (callee: string, arg: IrExpr): IrExpr => ({
  kind: "call",
  callee,
  args: [arg],
  type: BOOL,
  loc,
});
test("helper parameters read only by lending consumers accept stack slices", () => {
  const recursive = helper("isGet", [
    {
      kind: "return",
      value: {
        kind: "logical",
        op: "||",
        left: equals(ref("text")),
        right: callOf("isGet", ref("text")),
        type: BOOL,
        loc,
      },
      loc,
    },
  ]);
  const keeps = helper("keeps", [{ kind: "return", value: callOf("stores", ref("text")), loc }]);
  const stores = helper("stores", [
    {
      kind: "exprStmt",
      expr: { kind: "arrayLit", elems: [ref("text")], type: { kind: "array", elem: STRING }, loc },
      loc,
    },
    { kind: "return", value: { kind: "boolLit", value: true, type: BOOL, loc }, loc },
  ]);
  const lent = slice("source", 0, 3);
  const kept = slice("source", 0, 4);
  const fn = lending([
    { kind: "exprStmt", expr: callOf("isGet", lent), loc },
    { kind: "exprStmt", expr: callOf("keeps", kept), loc },
  ]);
  const functions = [recursive, keeps, stores];
  expect(scratch(fn, functions)).toEqual(new Set([lent]));
  const all = new Map([fn, ...functions].map((f) => [f.name, f]));
  expect([...findLentStringParameters(all, analyzeCallLifetimes(all)).keys()]).toEqual(["isGet"]);
});
