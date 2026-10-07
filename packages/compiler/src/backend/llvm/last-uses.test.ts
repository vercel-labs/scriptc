import { expect, test } from "vitest";
import { BOOL, STRING, type IrExpr, type IrStmt } from "../../ir/ir.js";
import { lastUseReads } from "./last-uses.js";

const reads = (body: IrStmt[]) => lastUseReads(body, new Set(["x"]));

const loc = { file: "last-uses.ts", start: 0, end: 0 };
const read = (localId = "x"): IrExpr => ({ kind: "varRef", localId, type: STRING, loc });
const call = (callee: string, args: IrExpr[], type = STRING): IrExpr => ({
  kind: "call",
  callee,
  args,
  type,
  loc,
});
const statement = (expr: IrExpr): IrStmt => ({ kind: "exprStmt", expr, loc });

test("a read after completed boolean operands moves; one beside a pending operand does not", () => {
  const first = read();
  const final = read();
  const completed = statement({
    kind: "logical",
    op: "&&",
    left: call("check", [first], BOOL),
    right: call("take", [final], BOOL),
    type: BOOL,
    loc,
  });
  expect([...reads([completed])]).toEqual([final]);

  const borrowed = read();
  const pending = read();
  expect(reads([statement(call("pair", [borrowed, call("take", [pending])]))]).size).toBe(0);
  expect(
    reads([
      statement({
        kind: "strEq",
        negated: false,
        left: read(),
        right: call("take", [read()]),
        type: BOOL,
        loc,
      }),
    ]).size,
  ).toBe(0);
});

test("later statements, handlers and loops keep reads owned", () => {
  const early = read();
  const late = read();
  expect([...reads([statement(call("take", [early])), statement(call("take", [late]))])]).toEqual([
    late,
  ]);

  const guarded = read();
  const tryCatch: IrStmt = {
    kind: "tryCatch",
    tryBody: [statement(call("take", [guarded]))],
    catchLocalId: null,
    catchBody: null,
    finallyBody: [statement(call("log", [read()]))],
    loc,
  };
  expect(reads([tryCatch]).has(guarded)).toBe(false);

  const loop: IrStmt = {
    kind: "while",
    cond: { kind: "boolLit", value: true, type: BOOL, loc },
    body: [statement(call("take", [read()]))],
    loc,
  };
  expect(reads([loop]).size).toBe(0);
});

test("a reference-typed short circuit keeps its operand pending", () => {
  const left = read();
  const right = read();
  const either: IrExpr = {
    kind: "logical",
    op: "||",
    left,
    right: call("take", [right]),
    type: STRING,
    loc,
  };
  expect(reads([statement(call("keep", [either]))]).has(right)).toBe(false);
});
