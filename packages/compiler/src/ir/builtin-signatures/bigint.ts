import { BIGINT_T, BOOL, BYTES_U8, F64, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The bigint builtin call slots. */
export const bigintSignatures = defineLibFnSignatures({
  /** Engine-free arbitrary-precision bigint operations (scr_bigint.c).
   * parse accepts the ECMAScript BigInt string grammar; fromF64 accepts
   * finite integral Numbers. Arithmetic returns fresh immutable values.
   * cmp returns -1/0/1 as f64; toString accepts a numeric radix. */
  "bigint.parse": { argTypes: [STRING], result: BIGINT_T },
  "bigint.fromF64": { argTypes: [F64], result: BIGINT_T },
  "bigint.neg": { argTypes: [BIGINT_T], result: BIGINT_T },
  "bigint.not": { argTypes: [BIGINT_T], result: BIGINT_T },
  "bigint.add": { argTypes: [BIGINT_T, BIGINT_T], result: BIGINT_T },
  "bigint.sub": { argTypes: [BIGINT_T, BIGINT_T], result: BIGINT_T },
  "bigint.mul": { argTypes: [BIGINT_T, BIGINT_T], result: BIGINT_T },
  "bigint.div": { argTypes: [BIGINT_T, BIGINT_T], result: BIGINT_T },
  "bigint.mod": { argTypes: [BIGINT_T, BIGINT_T], result: BIGINT_T },
  "bigint.pow": { argTypes: [BIGINT_T, BIGINT_T], result: BIGINT_T },
  "bigint.and": { argTypes: [BIGINT_T, BIGINT_T], result: BIGINT_T },
  "bigint.or": { argTypes: [BIGINT_T, BIGINT_T], result: BIGINT_T },
  "bigint.xor": { argTypes: [BIGINT_T, BIGINT_T], result: BIGINT_T },
  "bigint.shl": { argTypes: [BIGINT_T, BIGINT_T], result: BIGINT_T },
  "bigint.shr": { argTypes: [BIGINT_T, BIGINT_T], result: BIGINT_T },
  "bigint.eq": { argTypes: [BIGINT_T, BIGINT_T], result: BOOL },
  "bigint.eqString": { argTypes: [BIGINT_T, STRING], result: BOOL },
  "bigint.cmp": { argTypes: [BIGINT_T, BIGINT_T], result: F64 },
  "bigint.cmpNumber": { argTypes: [BIGINT_T, F64], result: F64 },
  "bigint.truthy": { argTypes: [BIGINT_T], result: BOOL },
  "bigint.toString": { argTypes: [BIGINT_T, F64], result: STRING },
  "bigint.inspect": { argTypes: [BIGINT_T], result: STRING },
  "bigint.toF64": { argTypes: [BIGINT_T], result: F64 },
  "bigint.asUintN": { argTypes: [F64, BIGINT_T], result: BIGINT_T },
  "bigint.asIntN": { argTypes: [F64, BIGINT_T], result: BIGINT_T },
  "bigint.bufferRead": { argTypes: [BYTES_U8, F64, BOOL, BOOL], result: BIGINT_T },
  "bigint.bufferWrite": { argTypes: [BYTES_U8, BIGINT_T, F64, BOOL, BOOL], result: F64 },
  "bigint.dataViewGet": { argTypes: [BYTES_U8, F64, BOOL, BOOL], result: BIGINT_T },
  "bigint.dataViewSet": { argTypes: [BYTES_U8, F64, BIGINT_T, BOOL], result: VOID },
});
