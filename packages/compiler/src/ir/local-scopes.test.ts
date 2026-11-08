import { describe, expect, test } from "vitest";
import {
  BOOL,
  F64,
  STRING,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrStmt,
} from "./ir.js";
import { localScopeUses, ownEscapingLocals } from "./local-scopes.js";

const loc = { file: "local-scopes.ts", start: 0, end: 0 };
const text = (value: string): IrExpr => ({ kind: "strLit", value, type: STRING, loc });
const ref = (localId: string): IrExpr => ({ kind: "varRef", localId, type: STRING, loc });
const truth: IrExpr = { kind: "boolLit", value: true, type: BOOL, loc };
const declare = (localId: string, init: IrExpr | null = text(localId)): IrStmt => ({
  kind: "varDecl",
  localId,
  init,
  loc,
});
const read = (localId: string): IrStmt => ({ kind: "exprStmt", expr: ref(localId), loc });
/** `stmts; result`, as a condition when `result` is a boolean. */
const sequence = (stmts: IrStmt[], result: IrExpr = truth): IrExpr => ({
  kind: "seqExpr",
  stmts,
  result,
  type: result.type,
  loc,
});
const string = (id: string, more: Partial<IrLocal> = {}): IrLocal => ({
  id,
  name: id,
  type: STRING,
  mutable: false,
  ...more,
});

function fn(body: IrStmt[], locals: IrLocal[] = [string("h"), string("k")]): IrFunction {
  return { name: "f", params: [], returnType: F64, locals, body, loc } as IrFunction;
}
const classes = (f: IrFunction): string[] =>
  localScopeUses(f).map((u) => `${u.local.id}:${u.ended}:${u.owner}`);

describe("localScopeUses", () => {
  test("a sequence's local is named by the rest of its statement", () => {
    expect(
      classes(
        fn([
          {
            kind: "exprStmt",
            expr: {
              kind: "strConcat",
              left: sequence([declare("h")], ref("h")),
              right: ref("h"),
              type: STRING,
              loc,
            },
            loc,
          },
        ]),
      ),
    ).toEqual([]);
  });

  test("a later statement reads a local after its statement ended", () => {
    expect(
      classes(fn([{ kind: "exprStmt", expr: sequence([declare("h")]), loc }, read("h")])),
    ).toEqual(["h:statement:exprStmt"]);
  });

  test("a condition's local has ended in the branches and after the statement", () => {
    const branch: IrStmt = {
      kind: "if",
      cond: sequence([declare("h")]),
      then: [read("h")],
      else_: [read("h")],
      loc,
    };
    expect(classes(fn([branch, read("h")]))).toEqual([
      "h:condition:if",
      "h:condition:if",
      "h:condition:if",
    ]);
  });

  test("loop conditions end before the body, a `do` condition before its next pass", () => {
    const cond = (): IrExpr => sequence([declare("h")]);
    expect(classes(fn([{ kind: "while", cond: cond(), body: [read("h")], loc }]))).toEqual([
      "h:condition:while",
    ]);
    expect(classes(fn([{ kind: "doWhile", cond: cond(), body: [read("h")], loc }]))).toEqual([
      "h:condition:doWhile",
    ]);
    expect(
      classes(
        fn([{ kind: "for", init: null, cond: cond(), update: null, body: [read("h")], loc }]),
      ),
    ).toEqual(["h:condition:for"]);
  });

  test("a switch discriminant and a for-of iterable live through the body", () => {
    expect(
      classes(
        fn([
          {
            kind: "switch",
            disc: sequence([declare("h")], ref("h")),
            cases: [{ test: text("a"), body: [read("h")] }],
            loc,
          },
        ]),
      ),
    ).toEqual([]);
  });

  test("a lazy arm's local has ended outside the arm", () => {
    const chain: IrExpr = {
      kind: "logical",
      op: "&&",
      left: truth,
      right: sequence([declare("h")]),
      type: BOOL,
      loc,
    };
    expect(classes(fn([{ kind: "if", cond: chain, then: [read("h")], else_: null, loc }]))).toEqual(
      ["h:arm:if"],
    );
  });

  test("a list's local has ended after the list", () => {
    expect(classes(fn([{ kind: "block", body: [declare("h")], loc }, read("h")]))).toEqual([
      "h:block:block",
    ]);
  });

  test("scalars are not reported, a boxed scalar is", () => {
    const body = (): IrStmt[] => [{ kind: "block", body: [declare("n", null)], loc }, read("n")];
    const scalar: IrLocal = { id: "n", name: "n", type: F64, mutable: true };
    expect(classes(fn(body(), [scalar]))).toEqual([]);
    expect(classes(fn(body(), [{ ...scalar, boxed: true }]))).toEqual(["n:block:block"]);
  });

  test("a closure's captures and an assignment are uses", () => {
    const capture: IrStmt = {
      kind: "exprStmt",
      expr: { kind: "closure", fnName: "g", captures: ["h"], type: F64, loc } as IrExpr,
      loc,
    };
    const write: IrStmt = { kind: "assign", localId: "h", value: text("x"), loc };
    expect(
      classes(fn([{ kind: "exprStmt", expr: sequence([declare("h")]), loc }, capture, write])),
    ).toEqual(["h:statement:exprStmt", "h:statement:exprStmt"]);
  });
});

describe("ownEscapingLocals", () => {
  test("leaves a function whose locals stay inside their regions as it is", () => {
    const f = fn([{ kind: "exprStmt", expr: sequence([declare("h")], ref("h")), loc }]);
    const before = JSON.stringify(f);
    expect(ownEscapingLocals(f)).toBe(false);
    expect(JSON.stringify(f)).toBe(before);
  });

  test("the list around the statement declares a condition's local", () => {
    const f = fn([
      { kind: "if", cond: sequence([declare("h")]), then: [read("h")], else_: null, loc },
    ]);
    expect(ownEscapingLocals(f)).toBe(true);
    expect(f.body.map((s) => s.kind)).toEqual(["varDecl", "if"]);
    expect(f.body[0]).toMatchObject({ kind: "varDecl", localId: "h", init: null });
    const cond = (f.body[1] as IrStmt & { kind: "if" }).cond as IrExpr & { kind: "seqExpr" };
    expect(cond.stmts).toMatchObject([{ kind: "assign", localId: "h" }]);
    expect(f.locals[0]!.mutable).toBe(true);
    expect(localScopeUses(f)).toEqual([]);
  });

  test("a loop body resets the local on each pass", () => {
    const inner: IrStmt = {
      kind: "if",
      cond: sequence([declare("h")]),
      then: [read("h")],
      else_: null,
      loc,
    };
    const f = fn([{ kind: "while", cond: truth, body: [inner], loc }]);
    ownEscapingLocals(f);
    const loop = f.body[0] as IrStmt & { kind: "while" };
    expect(f.body.length).toBe(1);
    expect(loop.body.map((s) => s.kind)).toEqual(["varDecl", "if"]);
  });

  test("a local used after the list moves out one list at a time", () => {
    const inner: IrStmt = {
      kind: "if",
      cond: sequence([declare("h")]),
      then: [read("h")],
      else_: null,
      loc,
    };
    const f = fn([
      { kind: "block", body: [{ kind: "block", body: [inner], loc }], loc },
      read("h"),
    ]);
    expect(ownEscapingLocals(f)).toBe(true);
    expect(f.body.map((s) => s.kind)).toEqual(["varDecl", "block", "exprStmt"]);
    expect(JSON.stringify(f.body[1])).not.toContain("varDecl");
    expect(localScopeUses(f)).toEqual([]);
  });

  test("a case's local is declared before the switch", () => {
    const f = fn([
      {
        kind: "switch",
        disc: text("a"),
        cases: [
          { test: text("a"), body: [{ kind: "exprStmt", expr: sequence([declare("h")]), loc }] },
          { test: null, body: [read("h")] },
        ],
        loc,
      },
    ]);
    expect(ownEscapingLocals(f)).toBe(true);
    expect(f.body.map((s) => s.kind)).toEqual(["varDecl", "switch"]);
  });

  test("two sequences that declare one local share one declaration", () => {
    const first: IrStmt = { kind: "exprStmt", expr: sequence([declare("h")]), loc };
    const second: IrStmt = { kind: "exprStmt", expr: sequence([declare("h")]), loc };
    const f = fn([{ kind: "block", body: [first], loc }, second, read("h")]);
    expect(ownEscapingLocals(f)).toBe(true);
    expect(f.body.map((s) => s.kind)).toEqual(["varDecl", "block", "exprStmt", "exprStmt"]);
    expect(JSON.stringify(f).match(/"varDecl"/g)?.length).toBe(1);
    expect(localScopeUses(f)).toEqual([]);
  });

  test("a local a list declared itself is left for the validator", () => {
    const f = fn([{ kind: "block", body: [declare("h")], loc }, read("h")]);
    expect(ownEscapingLocals(f)).toBe(false);
    expect(classes(f)).toEqual(["h:block:block"]);
  });
});
