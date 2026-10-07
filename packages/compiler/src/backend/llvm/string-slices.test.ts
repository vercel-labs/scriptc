import { expect, test } from "vitest";
import { F64, STRING, VOID, type IrExpr, type IrFunction, type IrStmt } from "../../ir/ir.js";
import { analyzeCallLifetimes } from "./call-lifetimes.js";
import { findScalarStringSlices } from "./string-slices.js";
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
