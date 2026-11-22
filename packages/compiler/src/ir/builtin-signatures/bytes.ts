import { BOOL, BYTES_U8, DYN, F64, STRING, VOID } from "../ir.js";
import { defineLibFnSignatures } from "./shared.js";

/** The bytes builtin call slots. */
export const bytesSignatures = defineLibFnSignatures({
  "bytes.equalsChk": { argTypes: [BYTES_U8, DYN], result: BOOL },
  "bytes.compareChk": { argTypes: [BYTES_U8, DYN, DYN, DYN, DYN, DYN], result: F64 },
  "bytes.constructor": { argTypes: [STRING], result: DYN },
  "bytes.instanceOf": { argTypes: [DYN, DYN, STRING], result: BOOL },
  "bytes.construct": { argTypes: [DYN, DYN, STRING], result: DYN },
  "bytes.bufferSource": { argTypes: [DYN], result: BYTES_U8 },
  /** Whether an error-first callback's Buffer result is absent: the zlib
   * and crypto callback adapters pass NULL after an error. Borrowed arg;
   * never throws. */
  "bytes.isAbsent": { argTypes: [BYTES_U8], result: BOOL },
  /** Whether two typed arrays share no byte: their element ranges in
   * memory do not overlap. Borrowed args of any element kind; never throws. */
  "bytes.disjoint": { argTypes: [null, null], result: BOOL },
  /** The absent Buffer result itself (NULL), where an error-path callback
   * body passes its undefined result on into a Buffer slot. Owned (+1);
   * never throws. */
  "bytes.absent": { argTypes: [], result: BYTES_U8 },
  /** The Buffer brand of a Uint8Array source onto a fresh Uint8Array
   * result (map and filter of a Buffer return a Buffer). */
  "bytes.copyBrand": { argTypes: [BYTES_U8, BYTES_U8], result: VOID },
  /** The typed-array callback methods' entry guard (t262-dc2), for a
   * mutableBuffers program: Node's ValidateTypedArray throws for a
   * detached or out-of-bounds receiver before the visit starts. The
   * second argument names the method in Node's message (%TypedArray%.prototype.<name>).
   * Borrowed args; VOID, may throw. */
  "bytes.requireLive": { argTypes: [null, STRING], result: VOID },
  /** The element at an index as a JavaScript value (t262-dc2): undefined
   * past the live length, where a visit's captured bound can run past a
   * shrink. Owned (+1) checked-dynamic result; never throws. */
  "bytes.itemDyn": { argTypes: [null, F64], result: DYN },
});
