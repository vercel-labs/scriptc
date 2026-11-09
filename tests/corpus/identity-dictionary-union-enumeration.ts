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

// Two held values laid over each other: dictionaries merge key by key into a
// new dictionary, and anything else is replaced.
function overlay(under: Json, over: Json): Json {
  if (under === null || over === null || typeof under !== "object" || typeof over !== "object") return over;
  if (Array.isArray(under) || Array.isArray(over)) return over;
  const merged: JsonObject = {};
  for (const key of Object.keys(under)) merged[key] = under[key] ?? null;
  for (const [key, value] of Object.entries(over)) merged[key] = key in under ? overlay(under[key] ?? null, value) : value;
  return merged;
}
const patch: JsonObject = { b: { loud: true }, c: [0], z: "last" };
console.log(JSON.stringify(overlay(dict, patch)), JSON.stringify(overlay(patch, dict)));
console.log(JSON.stringify(overlay({ deep: { x: 1, y: [1] } }, { deep: { y: { w: 2 } } })), JSON.stringify(overlay(dict, 5)));
