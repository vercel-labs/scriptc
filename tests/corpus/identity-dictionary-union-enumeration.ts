// What Object.keys, Object.entries, Object.values, spread, `in`, for...in and indexing answer
// for the object arm of a JSON value type whose dictionary keeps identity.
type Json = null | boolean | number | string | Json[] | JsonObject;
type JsonObject = { [key: string]: Json };

const fixed = { a: 1, b: "x" };
const dict: JsonObject = fixed;
dict.c = [true, { d: null }];

function describe(value: Json): string {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    const entries = Object.entries(value).map(([key, nested]) => `${key}=${JSON.stringify(nested)}`);
    const values = Object.values(value).map((nested) => JSON.stringify(nested));
    const copy: JsonObject = { ...value, extra: 1 };
    const seen: string[] = [];
    for (const key in value) seen.push(key);
    return [
      keys.join(","),
      entries.join(";"),
      values.join(";"),
      Object.keys(copy).join(","),
      seen.join(","),
      String("a" in value),
      String("nope" in value),
      JSON.stringify(value["c"] ?? "absent"),
      JSON.stringify(value["nope"] ?? "absent"),
    ].join(" | ");
  }
  return "-";
}
console.log(describe(dict));
console.log(describe(JSON.parse('{"k":[1,{"deep":true}],"a":null}') as Json));
console.log(describe({ one: 1, two: { three: 3 } }));
console.log(describe({}), describe([1]), describe("s"), describe(null));

function keysOf(value: Json): string[] {
  if (value !== null && typeof value === "object") return Object.keys(value);
  return [];
}
console.log(JSON.stringify(keysOf(dict)), JSON.stringify(keysOf(["p", "q"])), JSON.stringify(keysOf("s")));

function clean(value: Json): Json {
  if (Array.isArray(value)) return value.map(clean);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key.length > 0)
        .map(([key, nested]) => [key, clean(nested)]),
    );
  }
  return value;
}
const messy: JsonObject = { "": 0, keep: ["p", { "": 1, q: 2 }] };
console.log(JSON.stringify(clean(messy)), JSON.stringify(clean(dict)), JSON.stringify(clean(["p", { q: 1 }])));
