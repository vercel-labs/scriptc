import { BOOL, DYN, F64, STRING } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The num builtin call slots. */
export const numSignatures = defineLibFnSignatures({
  /** The static global parsers/tests (scr_string.c). num.parseInt is
   * ECMA-262 19.2.5 exactly — JS whitespace, sign, ToInt32 radix (the
   * frontend completes an omitted radix to 0 = the spec's "undefined":
   * base 10 with the 0x hex escape), longest digit prefix, and the exact
   * mathematical value correctly rounded (u64 fast path, bignum beyond —
   * overflow is ±Infinity). num.isNaN is the NaN self-test on an
   * already-number argument (tsc pins the argument to number, so no
   * ToNumber coercion exists to model). Borrow; never throw. */
  "num.parseInt": { argTypes: [STRING, F64], result: F64 },
  /** ES parseFloat (scr_string.c): the longest StrDecimalLiteral prefix
   * of the trimmed input (no hex, "Infinity" exact-case), NaN when none —
   * ECMA-262 19.2.4 over a string argument (non-string arguments keep the
   * fence: Node would ToNumber-coerce). Borrows; never throws. */
  "num.parseFloat": { argTypes: [STRING], result: F64 },
  /* ToNumber(string) — ECMA-262 7.1.4.1 StringToNumber (scr_string.c):
   * trim the JS StrWhiteSpace set, empty/whitespace-only → +0, then the
   * whole span must be one StrNumericLiteral — signed decimal (Infinity
   * included, strtod-over-validated-span correct rounding) or unsigned
   * 0x/0o/0b (exact value, nearest-even; signed forms are NaN) — with
   * any trailing garbage answering NaN. Number(aString), unary + on
   * strings, and util.format %d over strings lower here. Borrows; never
   * throws. */
  "num.fromString": { argTypes: [STRING], result: F64 },
  "num.isNaN": { argTypes: [F64], result: BOOL },
  /** Number.prototype formatters (scr_lib.c), JS-exact:
   * num.toExponential is toExponential() with the spec's "as many digits
   * as necessary"; num.toFixed0 is the non-throwing omitted-argument
   * toFixed() fast path; num.toFixed implements an explicit fractionDigits
   * with exact binary-value rounding and THROWS RangeError outside 0..100.
   * Successful results +1. */
  "num.toExponential": { argTypes: [F64], result: STRING },
  "num.toFixed0": { argTypes: [F64], result: STRING },
  "num.toFixed": { argTypes: [F64, F64], result: STRING },
  /** toPrecision(precision) with the argument ToNumber'd and its presence
   * (undefined answers ToString); toExponential with a DEFINED
   * fractionDigits. Both throw V8's RangeError for out-of-range digits. */
  "num.toPrecision": { argTypes: [F64, F64, BOOL], result: STRING },
  "num.toExponentialDigits": { argTypes: [F64, F64], result: STRING },
  "num.toStringRadix": { argTypes: [F64, DYN], result: STRING },
  /** toString(radix) with a number radix (scr_lib.c): truncates it as
   * ToIntegerOrInfinity does, THROWS RangeError outside 2..36. */
  "num.toStringRadixF64": { argTypes: [F64, F64], result: STRING },
  /** Object.is over two numbers — the spec's SameValue on doubles: NaN
   * equals NaN, +0 differs from -0, everything else is `===`. Plain bool
   * result; never throws. (Union-armed operands take unionEq's sameValue
   * flag instead — this is the both-f64 fast path.) */
  "num.sameValue": { argTypes: [F64, F64], result: BOOL },
});
