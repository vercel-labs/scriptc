import { expect, test } from "vitest";
import { matchStringSelfConcat } from "./analysis.js";
import { F64, STRING, type IrExpr } from "./ir.js";

const loc = { file: "analysis.ts", start: 0, end: 0 };
const str = (value: string): IrExpr => ({ kind: "strLit", value, type: STRING, loc });
const ref = (localId: string, type = STRING): IrExpr => ({ kind: "varRef", localId, type, loc });
const concat = (left: IrExpr, right: IrExpr, type = STRING): IrExpr => ({
  kind: "strConcat", left, right, type, loc,
});

test("matchStringSelfConcat recognizes only the immediate string self-concat", () => {
  const suffix = str("x");
  expect(matchStringSelfConcat("acc", concat(ref("acc"), suffix))).toBe(suffix);
});

test("matchStringSelfConcat rejects non-canonical and non-string shapes", () => {
  expect(matchStringSelfConcat("acc", concat(ref("other"), str("x")))).toBeNull();
  expect(matchStringSelfConcat("acc", concat(concat(ref("acc"), str("x")), str("y")))).toBeNull();
  expect(matchStringSelfConcat("acc", str("x"))).toBeNull();
  expect(matchStringSelfConcat("acc", concat(ref("acc", F64), str("x")))).toBeNull();
  expect(matchStringSelfConcat("acc", concat(ref("acc"), str("x"), F64))).toBeNull();
});
