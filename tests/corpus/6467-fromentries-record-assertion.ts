// `Object.fromEntries(...) as T` for a declared record T keeps exactly
// the keys the entries created, in their order, as Node keeps the object
// itself, as long as the entries hold scalars or checked-dynamic values.
type Tags = { "error.type": string; "error.msg": string; "error.cause"?: string };

function scrub(input: string): string {
  return input.replace(/secret/g, "***");
}

function redact(tags: Tags): Tags {
  return Object.fromEntries(
    Object.entries(tags).map(([key, value]) => [key, typeof value === "string" ? scrub(value) : value]),
  ) as Tags;
}

const e = new Error("a secret here");
const plain = redact({ "error.type": e.name, "error.msg": e.message });
console.log(plain, Object.keys(plain), "error.cause" in plain, plain["error.msg"].length);
const caused = redact({ "error.type": "TypeError", "error.msg": "m", "error.cause": "secret cause" });
console.log(caused, JSON.stringify(caused));

// Keys the record does not declare stay with the object.
type Point = { x: number; y: number };
const p = Object.fromEntries([
  ["y", 2],
  ["x", 1],
  ["z", 3],
]) as Point;
console.log(p, p.x + p.y, Object.keys(p), JSON.stringify(p));

// Entries held as unknown keep their identity: the object's members are
// the same array and record, and writes through either reach both.
type Holder = { list: number[]; point: { x: number } };
const list = [1, 2];
const point = { x: 1 };
const entries: [string, unknown][] = [
  ["list", list],
  ["point", point],
];
const held = Object.fromEntries(entries) as Holder;
held.list.push(3);
held.point.x = 5;
console.log(list.length, point.x, held.list === list, held.point === point);
