// A JSON value type whose object arm is a dictionary that keeps identity: an existing
// record enters the dictionary type and is written through it.
type Json = null | boolean | number | string | Json[] | JsonObject;
type JsonObject = { [key: string]: Json };

const fixed = { a: 1 };
const dict: JsonObject = fixed;
dict.z = true;

const parsed = JSON.parse('{"b":1,"a":[true,{"c":null}],"s":"t"}') as Json;
const literal: Json = { p: 1, q: ["x", { r: null }] };
const held: Json = dict;
console.log(JSON.stringify(parsed));
console.log(JSON.stringify(literal));
console.log(JSON.stringify(held), JSON.stringify(dict), JSON.stringify(fixed));
console.log(held === dict, (dict as unknown) === fixed);

function kind(value: Json): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === "object") return `object(${Object.keys(value).join(",")})`;
  return typeof value;
}
console.log(kind(parsed), kind(literal), kind(held), kind(dict));
console.log(kind([1, [2]]), kind("s"), kind(3), kind(true), kind(null), kind({}), kind({ only: [] }));

function depth(value: Json): number {
  if (value === null || typeof value !== "object") return 0;
  if (Array.isArray(value)) {
    let deepest = 0;
    for (const item of value) deepest = Math.max(deepest, depth(item));
    return 1 + deepest;
  }
  let most = 0;
  for (const key of Object.keys(value)) most = Math.max(most, depth(value[key] ?? null));
  return 1 + most;
}
console.log(depth(parsed), depth(literal), depth(held), depth(7), depth([[[]]]));

function build(levels: number): Json {
  return levels === 0 ? "leaf" : { level: levels, next: build(levels - 1), list: [levels, null] };
}
const built = build(3);
console.log(JSON.stringify(built), depth(built));
const cast = { n: 1, inner: { m: [2, "x"] } } as Json;
console.log(JSON.stringify(cast), kind(cast));
const round = JSON.parse(JSON.stringify(built)) as Json;
console.log(JSON.stringify(round) === JSON.stringify(built));
