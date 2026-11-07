// Object.entries and Object.keys over what `typeof v === "object"` leaves of
// a recursive JSON value: its array arm and its object arm. Node lists an
// array's indices and an object's own keys, integer-like keys first.
type Json = null | boolean | number | string | readonly Json[] | { [key: string]: Json };
type Doc = null | boolean | number | string | Doc[] | { [key: string]: Doc };

function clean(value: Json): Doc {
  if (Array.isArray(value)) {
    return value.map(clean);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key.length > 0)
        .map(([key, nested]) => [key, clean(nested)]),
    );
  }
  return value;
}
console.log(JSON.stringify(clean({ a: 1, "": 2, b: [true, null, { c: "x", "": 0 }], d: { e: null } })));

function keysOf(value: Json): string[] {
  if (value !== null && typeof value === "object") return Object.keys(value);
  return [];
}
function entriesOf(value: Json): [string, Json][] {
  if (value !== null && typeof value === "object") return Object.entries(value);
  return [];
}
const samples: Json[] = [{ b: 1, a: [true, null], 10: "ten", 2: "two" }, ["x", { y: 2 }, 3], "text", 7, null, [], {}];
for (const sample of samples) {
  console.log(JSON.stringify(keysOf(sample)), JSON.stringify(entriesOf(sample)));
}

// The entries keep the nested values themselves.
const inner: Json = { deep: [1] };
const outer: Json = { inner };
const [, held] = entriesOf(outer)[0]!;
console.log(JSON.stringify(held), JSON.stringify(entriesOf(held)));

// A union of an array and a fixed record.
function either(value: string[] | { a: number; b: string }): string {
  return Object.keys(value).join(",") + ":" + JSON.stringify(Object.entries(value));
}
console.log(either(["p", "q"]), either({ a: 1, b: "two" }));
