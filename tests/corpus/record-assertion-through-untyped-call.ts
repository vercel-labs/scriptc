// A `Record<string, T>` assertion of a value that came back from an untyped
// call is typing only: a key written through it reaches the record the
// caller still holds, and the assertion names that same value.
type Stats = { hits: number; bytes: number };
type Bag = { a: string; b: string };

function same(target: unknown): unknown {
  return target;
}

function bump(target: unknown, key: string, by: number): void {
  const record = target as Record<string, number>;
  record[key] = record[key]! + by;
}

function reset(target: unknown, key: string): void {
  let record = target as Record<string, number>;
  record[key] = 0;
}

function put(target: unknown, key: string, text: string): void {
  const record = target as Record<string, string>;
  record[key] = text;
}

function set(target: unknown, key: string, value: number): void {
  (target as Record<string, number>)[key] = value;
}

const two: Stats = { hits: 5, bytes: 1 };
bump(same(two), "hits", 1);
console.log("bump", two.hits, two.bytes);
reset(same(two), "bytes");
console.log("reset", two.hits, two.bytes);

const bag: Bag = { a: "x", b: "y" };
put(same(bag), "b", "z");
console.log("put", bag.a, bag.b);

const direct: Stats = { hits: 1, bytes: 2 };
set(same(direct), "bytes", 4);
console.log("direct", direct.hits, direct.bytes);

class Counter {
  hits = 5;
  bytes = 1;
}
const counter = new Counter();
bump(same(counter), "hits", 2);
console.log("class", counter.hits, counter.bytes);

const boxed = same(two);
const view = boxed as Record<string, number>;
console.log("identity", (view as unknown) === boxed);
view["hits"] = 9;
console.log("view", view["hits"], view["bytes"], Object.keys(view).join(","));
console.log("native", two.hits, two.bytes);
