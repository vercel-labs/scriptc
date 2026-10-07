import { expect, test } from "vitest";
import {
  F64,
  VOID,
  arrayOf,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type IrType,
} from "../../ir/ir.js";
import { analyzeCallLifetimes } from "./call-lifetimes.js";
import { ReferenceEffects } from "./reference-effects.js";
import { findLoopArrayBorrows } from "./loop-array-borrows.js";
const loc = { file: "loop.ts", start: 0, end: 0 };
const cell: IrType = { kind: "object", className: "Cell" };
const array = arrayOf(cell);
const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
function fixture(): { fn: IrFunction; read: IrStmt; loop: IrStmt & { kind: "for" } } {
  const read: IrStmt = {
    kind: "varDecl",
    localId: "cell",
    init: {
      kind: "arrayGet",
      arr: ref("items", array),
      index: { kind: "numLit", value: 0, type: F64, loc },
      type: cell,
      loc,
    },
    loc,
  };
  const loop: IrStmt & { kind: "for" } = {
    kind: "for",
    init: null,
    cond: null,
    update: null,
    body: [
      read,
      {
        kind: "exprStmt",
        expr: {
          kind: "fieldGet",
          obj: ref("cell", cell),
          className: "Cell",
          field: "value",
          type: F64,
          loc,
        },
        loc,
      },
    ],
    loc,
  };
  const fn: IrFunction = {
    name: "read",
    params: [{ localId: "items", name: "items", type: array }],
    locals: [
      { id: "items", name: "items", type: array, mutable: true },
      { id: "cell", name: "cell", type: cell, mutable: true },
    ],
    returnType: VOID,
    body: [loop],
    loc,
  };
  return { fn, read, loop };
}
function facts(fn: IrFunction): ReadonlySet<IrStmt> {
  const functions = new Map([[fn.name, fn]]);
  return findLoopArrayBorrows(
    fn,
    analyzeCallLifetimes(functions),
    new ReferenceEffects(functions, () => false),
  );
}
test("stable let reads borrow within a preserving iteration despite unrelated mutation", () => {
  const { fn, read } = fixture();
  fn.body.unshift({
    kind: "arraySetLength",
    arr: ref("items", array),
    length: { kind: "numLit", value: 1, type: F64, loc },
    loc,
  });
  expect(facts(fn)).toEqual(new Set([read]));
});
test.each(["mutation", "callback", "escape", "capture", "source-rebind", "update"])(
  "%s keeps an owned loop read",
  (variant) => {
    const { fn, loop } = fixture();
    const mutation: IrStmt = {
      kind: "arraySetLength",
      arr: ref("items", array),
      length: { kind: "numLit", value: 0, type: F64, loc },
      loc,
    };
    if (variant === "mutation") loop.body.push(mutation);
    if (variant === "callback")
      loop.body.push({
        kind: "exprStmt",
        expr: { kind: "call", callee: "unknown", args: [], type: VOID, loc },
        loc,
      });
    if (variant === "escape") loop.body.push({ kind: "return", value: ref("cell", cell), loc });
    if (variant === "capture") fn.locals[1]!.boxed = true;
    if (variant === "source-rebind")
      loop.body.push({ kind: "assign", localId: "items", value: ref("other", array), loc });
    if (variant === "update") loop.update = mutation;
    expect(facts(fn).size).toBe(0);
  },
);

test("for-of retains its iterable while projection-only elements borrow it", () => {
  const { fn, loop } = fixture();
  const iteration: IrStmt = {
    kind: "forOf",
    localId: "cell",
    iterable: ref("items", array),
    body: loop.body.slice(1),
    loc,
  };
  fn.body = [iteration];
  expect(facts(fn)).toEqual(new Set([iteration]));
  iteration.body.push({
    kind: "arraySetLength",
    arr: ref("items", array),
    length: { kind: "numLit", value: 0, type: F64, loc },
    loc,
  });
  expect(facts(fn).size).toBe(0);
});

test("captured and returned for-of elements retain their ordinary ownership", () => {
  const { fn } = fixture();
  const iteration: IrStmt = {
    kind: "forOf",
    localId: "cell",
    iterable: ref("items", array),
    body: [{ kind: "return", value: ref("cell", cell), loc }],
    loc,
  };
  fn.body = [iteration];
  expect(facts(fn).size).toBe(0);
  iteration.body = [
    {
      kind: "exprStmt",
      expr: {
        kind: "fieldGet",
        obj: ref("cell", cell),
        className: "Cell",
        field: "value",
        type: F64,
        loc,
      },
      loc,
    },
  ];
  fn.locals[1]!.boxed = true;
  expect(facts(fn).size).toBe(0);
});
