// A record with only an index signature that is an arm of a union, converted to an untyped value:
// a checked conversion into the union reads it as an untyped object, and so does a conversion of the
// union value itself. The record's header has a second word as a union arm; reading the map of its
// keys one word early crashed the process.
type Tagged = { kind: "a"; x: number };
type Dict = { [key: string]: string | number };

const src: Dict = { p: "q", n: 2 };
const boxed: unknown = src;
const v = boxed as Tagged | Dict;
console.log(JSON.stringify(v), Object.keys(v).join(","));
console.log("kind" in v, "p" in v);

const counts: Record<string, number> = { n: 2, m: 3 };
const loose: unknown = counts;
const w = loose as Tagged | Record<string, number>;
console.log(JSON.stringify(w), Object.keys(w).length);

function pick(n: number): Tagged | Dict {
  return n > 100 ? { kind: "a", x: 1 } : { p: "q", n: 2 };
}
const u = pick(process.argv.length);
const seen: unknown[] = [u, pick(1000)];
console.log(JSON.stringify(seen));
for (const item of seen) {
  const back = item as Tagged | Dict;
  console.log(JSON.stringify(back), Object.keys(back).join(","));
}

const tagged: Tagged = { kind: "a", x: 7 };
const other: unknown = tagged;
const t = other as Tagged | Dict;
console.log(JSON.stringify(t), t.kind);
