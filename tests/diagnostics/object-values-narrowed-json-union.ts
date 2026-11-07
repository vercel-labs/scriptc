// Object.values over what `typeof v === "object"` leaves of a JSON value
// types as any[], which has no array form; Object.keys and Object.entries
// of the same value compile (tests/corpus/object-entries-narrowed-json-union.ts).
type Json = null | boolean | number | string | readonly Json[] | { [key: string]: Json };
function valuesOf(value: Json): Json[] {
  if (value !== null && typeof value === "object") return Object.values(value);
  return [];
}
console.log(JSON.stringify(valuesOf({ a: 1 })));
