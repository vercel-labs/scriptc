import { BIGINT_T, BOOL, DYN, F64, JSVAL, STRING } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The js builtin call slots. */
export const jsSignatures = defineLibFnSignatures({
  /* Dynamic-tier values (jsval; two-tier design stage S3). The jsval pass
   * (ir/jsval.ts) introduces these in dynamic-tier functions only; the
   * runtime is scr_js_value.c. Arguments are borrowed and results owned,
   * like every libCall. Boundary conversions: js.fromDyn (a cell keeps its
   * identity), js.toDyn (an immediate is boxed), js.fromF64/fromBool/
   * fromStr/fromBigInt (the design's toJs: immediates, and strings and
   * BigInts under a tag without a copy) and js.toF64 (fromJs to number: dynCheck's
   * number check and TypeError). The operators are the dyn.* operators
   * over jsvals, with identical JS semantics. */
  "js.fromDyn": { argTypes: [DYN], result: JSVAL },
  "js.toDyn": { argTypes: [JSVAL], result: DYN },
  "js.fromF64": { argTypes: [F64], result: JSVAL },
  "js.fromBool": { argTypes: [BOOL], result: JSVAL },
  "js.fromStr": { argTypes: [STRING], result: JSVAL },
  "js.fromBigInt": { argTypes: [BIGINT_T], result: JSVAL },
  "js.toF64": { argTypes: [JSVAL], result: F64 },
  "js.add": { argTypes: [JSVAL, JSVAL], result: JSVAL },
  "js.arithmetic": { argTypes: [JSVAL, JSVAL, STRING], result: JSVAL },
  "js.bitwise": { argTypes: [JSVAL, JSVAL, STRING], result: JSVAL },
  "js.compare": { argTypes: [JSVAL, JSVAL, STRING], result: BOOL },
  "js.toNumeric": { argTypes: [JSVAL], result: JSVAL },
  "js.increment": { argTypes: [JSVAL, BOOL], result: JSVAL },
  "js.negate": { argTypes: [JSVAL], result: JSVAL },
  "js.toNumberCoerce": { argTypes: [JSVAL], result: F64 },
});
