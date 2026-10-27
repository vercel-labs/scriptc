/* jsval word encoding constants shared by the jsval emitter (jsval.ts) and
 * the RC helpers (shapes.ts). The authoritative description is scr_js.h. */

/** Bit patterns (decimal i64 literals; unsigned compares read them as
 * the 0xFFF9... words). */
export const JS_BITS = {
  /** Words below this are doubles; it is also undefined's word. */
  limit: "-1970324836974592",
  undefined: "-1970324836974592",
  null: "-1970324836974591",
  false: "-1970324836974590",
  true: "-1970324836974589",
  cellTag: "-1688849860263936",
  strTag: "-1407374883553280",
  bigintTag: "-1125899906842624",
  payloadMask: "281474976710655",
  canonicalNan: "9221120237041090560",
} as const;

/** The tag of a word (its top 16 bits) for each heap kind. */
export const JS_TAGS = { cell: 0xfffa, str: 0xfffb, bigint: 0xfffc } as const;
