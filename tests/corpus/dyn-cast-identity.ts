// A checked cast of a dynamic value to a record or array (`value as T`)
// keeps the value's identity: every cast of the same source, and the source
// itself, read and write one object.

type Point = { x: number; y: number };

// Two casts of one parsed object alias each other and the source.
const raw: unknown = JSON.parse('{"x":1,"y":2}');
const a = raw as Point;
const b = raw as Point;
a.x = 10;
b.y = 20;
console.log("aliasing", a.x, a.y, b.x, b.y);
console.log("identity", a === b, (raw as Point) === a);
console.log("source", JSON.stringify(raw));

// Nested objects keep their identity through the outer and inner casts.
type Outer = { name: string; inner: { v: number } };
const nestedRaw: unknown = JSON.parse('{"name":"o","inner":{"v":1}}');
const outer = nestedRaw as Outer;
const inner = (nestedRaw as { inner: unknown }).inner as { v: number };
inner.v = 2;
console.log("nested", outer.inner.v, outer.inner === inner);
outer.inner.v = 3;
console.log("nested back", inner.v);

// Arrays: pushes and element writes show through every cast.
const listRaw: unknown = JSON.parse("[1,2]");
const first = listRaw as number[];
const second = listRaw as number[];
first.push(3);
second[0] = 9;
console.log("array", first.length, second.length, first[0], first === second, JSON.stringify(listRaw));

// Arrays of records.
type Item = { id: number; tags: string[] };
const itemsRaw: unknown = JSON.parse('[{"id":1,"tags":["a"]},{"id":2,"tags":[]}]');
const items = itemsRaw as Item[];
const again = itemsRaw as Item[];
items[0]!.tags.push("b");
again[1]!.id = 7;
console.log("array of records", again[0]!.tags.join(","), items[1]!.id, items[0] === again[0]);

// The source stays an ordinary object for untyped reads and writes.
const bagRaw: unknown = JSON.parse('{"y":2,"x":1,"extra":"e"}');
const point = bagRaw as Point;
const bag = bagRaw as Record<string, unknown>;
bag.z = 3;
console.log("added", JSON.stringify(bagRaw), Object.keys(bag).join(","));
delete bag.extra;
console.log("deleted", JSON.stringify(bagRaw), JSON.stringify(point));
for (const k in bag) console.log("key", k, bag[k]);
point.x = 5;
console.log("typed write", bag.x);

// A native record boxed as unknown comes back as itself.
const native: Point = { x: 1, y: 2 };
const boxed: unknown = native;
const unboxed = boxed as Point;
unboxed.x = 10;
console.log("native", native.x, unboxed === native);

// A fresh parse result has no other holder.
const fresh = JSON.parse('{"x":4,"y":5}') as Point;
console.log("fresh", fresh.x + fresh.y);

// A frozen source keeps working as a copy.
const frozen: unknown = Object.freeze(JSON.parse('{"x":1,"y":2}'));
const held = [frozen];
const thawed = frozen as Point;
console.log("frozen", thawed.x, held.length, Object.isFrozen(frozen));
