import { expect, test } from "vitest";
import { BOOL, F64, type IrExpr, type IrFunction, type IrStmt } from "../../ir/ir.js";
import { runningExtremumUpdates } from "./running-extrema.js";

const loc = { file: "extrema.ts", start: 0, end: 0 };
const ref = (localId: string): IrExpr => ({ kind: "varRef", localId, type: F64, loc });
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const assign = (localId: string, value: IrExpr): IrStmt => ({
  kind: "assign",
  localId,
  value,
  loc,
});
const decl = (localId: string): IrStmt => ({ kind: "varDecl", localId, init: num(0), loc });
const compare = (op: "<" | ">", left: IrExpr, right: IrExpr): IrExpr => ({
  kind: "bin",
  op,
  left,
  right,
  type: BOOL,
  loc,
});
/** `if (v > max) max = v;` */
const update = (): IrStmt & { kind: "if" } => ({
  kind: "if",
  cond: compare(">", ref("v"), ref("max")),
  then: [assign("max", ref("v"))],
  else_: null,
  loc,
});
const loop = (body: IrStmt[]): IrStmt => ({
  kind: "while",
  cond: compare(">", ref("n"), num(0)),
  body,
  loc,
});
const fn = (body: IrStmt[], captures: string[] = []): IrFunction => ({
  name: "scan",
  params: [],
  locals: ["v", "max", "n"].map((id) => ({ id, name: id, type: F64, mutable: true })),
  captures: captures.map((localId) => ({ localId, name: localId, type: F64 })),
  returnType: F64,
  body,
  loc,
});

test("a loop's update of an accumulator declared outside it qualifies", () => {
  const s = update();
  expect(runningExtremumUpdates(fn([decl("max"), loop([decl("v"), s])])).has(s)).toBe(true);
});

test("the local may be on either side of the comparison", () => {
  const s = update();
  s.cond = compare("<", ref("max"), ref("v"));
  expect(runningExtremumUpdates(fn([decl("max"), loop([s])])).has(s)).toBe(true);
});

test("a local declared in the loop is not an accumulator", () => {
  const s = update();
  expect(runningExtremumUpdates(fn([loop([decl("max"), s])])).size).toBe(0);
});

test("another write in the loop disqualifies the update", () => {
  const s = update();
  const body = [decl("max"), loop([assign("max", num(1)), s])];
  expect(runningExtremumUpdates(fn(body)).size).toBe(0);
});

test("the assigned value must be the compared expression", () => {
  const s = update();
  s.then = [assign("max", num(5))];
  expect(runningExtremumUpdates(fn([decl("max"), loop([s])])).size).toBe(0);
});

test("outside a loop only a captured binding qualifies", () => {
  const captured = update();
  expect(runningExtremumUpdates(fn([captured], ["max"])).has(captured)).toBe(true);
  expect(runningExtremumUpdates(fn([update()])).size).toBe(0);
});

test("an else branch disqualifies the update", () => {
  const s = update();
  s.else_ = [assign("v", num(0))];
  expect(runningExtremumUpdates(fn([decl("max"), loop([s])])).size).toBe(0);
});

test("an update nested in another branch does not qualify", () => {
  const s = update();
  const guard: IrStmt = {
    kind: "if",
    cond: compare(">", ref("v"), num(0)),
    then: [s],
    else_: null,
    loc,
  };
  expect(runningExtremumUpdates(fn([decl("max"), loop([guard])])).size).toBe(0);
});
