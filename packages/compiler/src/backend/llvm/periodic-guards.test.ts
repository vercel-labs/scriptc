import { expect, test } from "vitest";
import { countedFor } from "../../ir/build.js";
import { BOOL, F64, type IrExpr, type IrStmt } from "../../ir/ir.js";
import {
  loopUnrollAttachment,
  loopUnrollMetadata,
  periodicGuardPeriod,
} from "./periodic-guards.js";

const loc = { file: "guards.ts", start: 0, end: 0 };
const ref = (localId: string): IrExpr => ({ kind: "varRef", localId, type: F64, loc });
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const bin = (op: string, left: IrExpr, right: IrExpr, type = F64): IrExpr =>
  ({ kind: "bin", op, left, right, type, loc }) as IrExpr;
const and = (left: IrExpr, right: IrExpr): IrExpr => ({
  kind: "logical",
  op: "&&",
  left,
  right,
  type: BOOL,
  loc,
});
const guard = (cond: IrExpr): IrStmt => ({
  kind: "if",
  cond,
  then: [{ kind: "break", loc } as IrStmt],
  else_: null,
  loc,
});
/** `for (i = 0; i < 50; i++) { ...body }` */
const loop = (body: IrStmt[]) => countedFor(loc, num(50), () => body) as IrStmt & { kind: "for" };
const period = (body: IrStmt[], start = 0, step = 1) =>
  periodicGuardPeriod(loop(body), "i.0", num(start), step);

test("a guard on the counter's low bits gives the loop its period", () => {
  // if ((i & 3) === 3 && x > 4) break;
  const masked = bin("===", bin("&", ref("i.0"), num(3)), num(3), BOOL);
  expect(period([guard(and(masked, bin(">", ref("x"), num(4), BOOL)))])).toBe(4);
  // if (0 == (7 & i)) ...
  expect(period([guard(bin("==", num(0), bin("&", num(7), ref("i.0")), BOOL))])).toBe(8);
  expect(period([guard(bin("!==", bin("&", ref("i.0"), num(1)), num(0), BOOL))])).toBe(2);
});

test("other guards and loops get no period", () => {
  const masked = (mask: number, value: number, counter = "i.0") =>
    guard(bin("===", bin("&", ref(counter), num(mask)), num(value), BOOL));
  // Masks that are not 1, 3 or 7, values outside the mask, another variable.
  expect(period([masked(5, 1)])).toBeNull();
  expect(period([masked(15, 15)])).toBeNull();
  expect(period([masked(3, 4)])).toBeNull();
  expect(period([masked(3, 3, "j")])).toBeNull();
  // The masked test is not the condition's first conjunct.
  const later = and(
    bin(">", ref("x"), num(4), BOOL),
    bin("===", bin("&", ref("i.0"), num(3)), num(3), BOOL),
  );
  expect(period([guard(later)])).toBeNull();
  // A start that is not a multiple of the period, a step other than 1.
  expect(period([masked(3, 3)], 1)).toBeNull();
  expect(period([masked(3, 3)], 0, 2)).toBeNull();
  // A nested loop.
  expect(period([masked(3, 3), loop([])])).toBeNull();
});

test("a large body is not unrolled", () => {
  const work: IrStmt[] = [];
  for (let k = 0; k < 400; k++)
    work.push({ kind: "assign", localId: "x", value: bin("+", ref("x"), num(k)), loc } as IrStmt);
  expect(
    period([guard(bin("===", bin("&", ref("i.0"), num(3)), num(3), BOOL)), ...work]),
  ).toBeNull();
});

test("the module carries the loop ID nodes its back edges refer to", () => {
  const lines = [`  br label %loop.c1${loopUnrollAttachment(4)}`, "  ret void"];
  expect(loopUnrollMetadata(lines)).toEqual([
    `!1000004 = distinct !{!1000004, !{!"llvm.loop.unroll.count", i32 4}}`,
  ]);
  expect(loopUnrollMetadata(["  ret void"])).toEqual([]);
});
