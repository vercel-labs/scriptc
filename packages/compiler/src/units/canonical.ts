/* Canonical JSON for the unit key and the unit summary: object keys sorted,
 * arrays in their written order, no whitespace. Two builds that agree on the
 * data produce the same bytes, which is what the key and the store's digest
 * compare. */

/** A JSON value canonical JSON accepts. `undefined` is not one: a member
 * whose value is undefined is dropped before it reaches the serializer. */
export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

/** `value` with every object's keys in sorted order. */
export function canonicalize(value: CanonicalValue): CanonicalValue {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((item: CanonicalValue) => canonicalize(item));
  if (typeof value === "object") {
    const sorted: { [key: string]: CanonicalValue } = {};
    const keys = Object.keys(value).sort();
    for (const key of keys) {
      const member = value[key];
      if (member === undefined) continue;
      sorted[key] = canonicalize(member);
    }
    return sorted;
  }
  return value;
}

/** The canonical JSON text of `value`. */
export function canonicalJson(value: CanonicalValue): string {
  return JSON.stringify(canonicalize(value));
}
