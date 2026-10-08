import { expect, test } from "vitest";
import {
  F64,
  funcOf,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type IrType,
} from "../../ir/ir.js";
import { LazyCaptures } from "./lazy-captures.js";

const loc = { file: "captures.ts", start: 0, end: 0 };
const record: IrType = { kind: "record", shapeId: "options" };
const ref = (localId: string): IrExpr => ({ kind: "varRef", localId, type: record, loc });
const closure = (fnName: string, captures: string[]): IrStmt => ({
  kind: "exprStmt",
  expr: { kind: "closure", fnName, captures, type: funcOf([], F64), loc },
  loc,
});
const assign = (localId: string): IrStmt => ({ kind: "assign", localId, value: ref(localId), loc });

function outer(body: IrStmt[], extra: Partial<IrFunction> = {}): IrFunction {
  return {
    name: "outer",
    params: [
      { localId: "options", name: "options", type: record },
      { localId: "plain", name: "plain", type: record },
    ],
    returnType: F64,
    locals: [
      { id: "options", name: "options", type: record, mutable: true, boxed: true },
      { id: "plain", name: "plain", type: record, mutable: true },
    ],
    body,
    loc,
    ...extra,
  };
}
function lifted(name: string, body: IrStmt[], captured = "options"): IrFunction {
  return {
    name,
    params: [],
    returnType: F64,
    captures: [{ localId: captured, name: captured, type: record }],
    locals: [{ id: captured, name: captured, type: record, mutable: true, boxed: true }],
    body,
    loc,
  };
}
function lazy(...functions: IrFunction[]): Set<string> {
  const map = new Map(functions.map((fn) => [fn.name, fn]));
  return new LazyCaptures(map).parameters(functions[0]!);
}

test("captured parameters that nothing rebinds are boxed lazily", () => {
  const reader = lifted("reader", [{ kind: "return", value: ref("options"), loc }]);
  expect(lazy(outer([closure("reader", ["options"])]), reader)).toEqual(new Set(["options"]));
});

test("rebinding in the body or in any nested function keeps the eager box", () => {
  const reader = lifted("reader", []);
  expect(lazy(outer([closure("reader", ["options"]), assign("options")]), reader).size).toBe(0);
  const writer = lifted("writer", [assign("options")]);
  expect(lazy(outer([closure("writer", ["options"])]), writer).size).toBe(0);
  // A write two closures deep reaches the same binding.
  const inner = lifted("inner", [{ kind: "return", value: ref("x"), loc }], "x");
  const middle = lifted("middle", [closure("inner", ["mid"])], "mid");
  expect(lazy(outer([closure("middle", ["options"])]), middle, inner).size).toBe(1);
  const deep = lifted("inner", [assign("x")], "x");
  expect(lazy(outer([closure("middle", ["options"])]), middle, deep).size).toBe(0);
});

test("class environments, async bodies and unknown targets keep the eager box", () => {
  const classRef: IrStmt = {
    kind: "exprStmt",
    expr: {
      kind: "classRef",
      className: "Local",
      captures: ["options"],
      type: { kind: "classval", className: "Local" },
      loc,
    },
    loc,
  };
  expect(lazy(outer([classRef])).size).toBe(0);
  const reader = lifted("reader", []);
  expect(lazy(outer([closure("reader", ["options"])], { async: true }), reader).size).toBe(0);
  expect(lazy(outer([closure("missing", ["options"])])).size).toBe(0);
});
