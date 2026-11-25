// A Map or a Set keyed by a union of a string and `null`, `undefined` or
// both: the unit arms are keys of their own, distinct from each other and
// from every string, and the union's values come back out as they went in.
class Entry {
  readonly key: string | null;
  readonly label: string | undefined;
  readonly both: string | null | undefined;
  constructor(key: string | null, label: string | undefined, both: string | null | undefined) {
    this.key = key;
    this.label = label;
    this.both = both;
  }
}

interface Row {
  key: string | null;
  note?: string | null;
}

function show(value: string | null | undefined): string {
  return value === null ? "<null>" : value === undefined ? "<undefined>" : JSON.stringify(value);
}

function keyOf(index: number): string | null {
  return index % 3 === 0 ? null : "k" + (index % 4);
}

function labelOf(index: number): string | undefined {
  return index % 4 === 0 ? undefined : "l" + (index % 3);
}

function bothOf(index: number): string | null | undefined {
  return index % 5 === 0 ? null : index % 5 === 1 ? undefined : "b" + (index % 2);
}

// Sets: add, has, delete, size, iteration order, spread, forEach.
const nullSet = new Set<string | null>();
const undefSet = new Set<string | undefined>();
const bothSet = new Set<string | null | undefined>();
for (let i = 0; i < 12; i++) {
  nullSet.add(keyOf(i));
  undefSet.add(labelOf(i));
  bothSet.add(bothOf(i));
}
console.log("sizes", nullSet.size, undefSet.size, bothSet.size);
console.log("has null", nullSet.has(null), "has k1", nullSet.has("k1"), "has k9", nullSet.has("k9"));
console.log("has undefined", undefSet.has(undefined), "has l0", undefSet.has("l0"));
console.log("both", bothSet.has(null), bothSet.has(undefined), bothSet.has("b0"), bothSet.has("b7"));
console.log("empty string", nullSet.has(""), undefSet.has(""), bothSet.has(""));
console.log([...nullSet].map(show).join(" "));
console.log([...undefSet].map(show).join(" "));
console.log(Array.from(bothSet).map(show).join(" "));
bothSet.forEach((value) => console.log("each", show(value)));
for (const value of nullSet) console.log("of", show(value), typeof value, value === null);
console.log("delete", nullSet.delete(null), nullSet.delete(null), nullSet.has(null), nullSet.size);
console.log("delete", bothSet.delete(undefined), bothSet.has(undefined), bothSet.has(null), bothSet.size);
nullSet.add("");
nullSet.add(null);
console.log([...nullSet].map(show).join(" "));

// A key built at run time equals the same text added before.
const built = ["k", String(1)].join("");
console.log("built", nullSet.has(built), built === "k1");

// Sets seeded from an array, and a Set of a Map's values.
const seeded = new Set<string | null>(["a", null, "b", "a", null]);
console.log("seeded", seeded.size, [...seeded].map(show).join(" "));
const seededBoth = new Set<string | null | undefined>([undefined, "x", null, undefined, "x"]);
console.log("seeded both", seededBoth.size, [...seededBoth].map(show).join(" "));
const byNumber = new Map<number, string | undefined>([
  [1, "one"],
  [2, undefined],
  [3, "one"],
  [4, "four"],
]);
const values = new Set<string | undefined>(byNumber.values());
console.log("values", values.size, [...values].map(show).join(" "));

// Maps: set, get, has, delete, overwrite, entries, keys, forEach.
const counts = new Map<string | null, number>();
const names = new Map<string | undefined, string>();
const entries = new Map<string | null | undefined, Entry>();
for (let i = 0; i < 12; i++) {
  const key = keyOf(i);
  counts.set(key, (counts.get(key) ?? 0) + 1);
  names.set(labelOf(i), "n" + i);
  const both = bothOf(i);
  entries.set(both, new Entry(key, labelOf(i), both));
}
console.log("map sizes", counts.size, names.size, entries.size);
console.log("get", counts.get(null), counts.get("k1"), counts.get("k2"), counts.get("zz"));
console.log("get", names.get(undefined), names.get("l1"), names.get("nope"));
for (const [key, count] of counts) console.log("count", show(key), count);
for (const key of names.keys()) console.log("name key", show(key));
entries.forEach((entry, key) => {
  console.log("entry", show(key), show(entry.key), show(entry.label), show(entry.both), entry.both === key);
});
console.log("delete", counts.delete(null), counts.has(null), counts.get(null), counts.size);
counts.set(null, 100);
console.log([...counts.keys()].map(show).join(" "), [...counts.values()].join(" "));
const literal = new Map<string | null, string>([
  [null, "none"],
  ["a", "A"],
  [null, "nothing"],
]);
console.log("literal", literal.size, literal.get(null), literal.get("a"));

// The union keeps its values in every other position of the program.
const rows: Row[] = [];
for (let i = 0; i < 6; i++) {
  const row: Row = i % 2 === 0 ? { key: keyOf(i) } : { key: keyOf(i), note: i % 3 === 0 ? null : "note" + i };
  rows.push(row);
}
const seenKeys = new Set<string | null>();
const seenNotes = new Set<string | null | undefined>();
for (const row of rows) {
  seenKeys.add(row.key);
  seenNotes.add(row.note);
  const read: string | null = row.key;
  const shown = (): string => show(read);
  console.log("row", shown(), show(row.note), read ?? "fallback", row.note?.length ?? -1);
}
console.log("seen", [...seenKeys].map(show).join(" "), "|", [...seenNotes].map(show).join(" "));

// As untyped values.
const untyped: unknown = nullSet;
if (untyped instanceof Set) {
  console.log("untyped", untyped.size, untyped.has(null), untyped.has("k1"), untyped.has(undefined));
  for (const value of untyped) console.log("untyped of", value === null ? "<null>" : typeof value);
}
const untypedMap: unknown = names;
if (untypedMap instanceof Map) {
  console.log("untyped map", untypedMap.size, untypedMap.has(undefined), untypedMap.get(undefined));
  for (const key of untypedMap.keys()) console.log("untyped key", key === undefined ? "<undefined>" : key);
}
console.log(nullSet);
console.log(names);
console.log(JSON.stringify([...bothSet]), JSON.stringify([...counts]));
