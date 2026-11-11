// An optional argument slot distinguishes an omitted undefined from a
// supplied value across a union: only undefined takes the default, and a
// null converts the way Node's own slot handling converts it — ToString(null)
// is "null", so a null normalization form reaches the form check and throws
// RangeError instead of silently normalizing with NFC. A union whose
// undefined arm comes from iterating a tuple still defaults that arm.
import { Buffer } from "node:buffer";

function shape(fn: () => string): string {
  try {
    return JSON.stringify(fn());
  } catch (e) {
    const err = e as Error & { code?: string };
    return err.name + " " + String(err.code) + " " + err.message;
  }
}

// String.prototype.normalize(form?): a null form is a value, not an omitted
// slot.
const form = "NFKC" as unknown as string | null | undefined;
// @ts-expect-error a nullable union is handed to the slot on purpose
console.log(shape(() => "ﬁ".normalize(form)));
const nullForm = null as unknown as string | null | undefined;
// @ts-expect-error a null form reaches the form check
console.log(shape(() => "x".normalize(nullForm)));
const undefinedForm = undefined as string | null | undefined;
// @ts-expect-error an undefined form takes the NFC default
console.log(shape(() => "é".normalize(undefinedForm)));

// String.prototype.split(separator?): null is ToString(null), so "null"
// splits where it occurs rather than defaulting to no separator.
const nullSeparator = null as unknown as string | null | undefined;
// @ts-expect-error a null separator is a value
console.log(shape(() => "anullb".split(nullSeparator).join("|")));
// @ts-expect-error the same value joins with "null" between the parts
console.log(shape(() => [1, 2].join(nullSeparator)));

// An iterated tuple's element type models absence as undefined, which the
// slot treats as omitted; its present values reach the slot unchanged.
for (const separator of [undefined, "ll", "o"] as const) {
  // @ts-expect-error split takes an omitted separator, not undefined
  console.log(String(separator), "hello".split(separator).length);
}
for (const form of [undefined, "NFC", "NFD"] as const) {
  console.log(String(form), "é".normalize(form).length);
}
for (const encoding of [undefined, "hex", "base64"] as const) {
  console.log(String(encoding), Buffer.from("6162", encoding).length);
}

// A number | undefined slot: undefined keeps the default, a value is used.
const offsets: Array<number | undefined> = [undefined, 2];
for (const offset of offsets) {
  const target = Buffer.alloc(4, 0x2e);
  target.fill(0x61, offset);
  console.log(String(offset), target.toString("latin1"));
}
