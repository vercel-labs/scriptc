// A Map or a Set held by a record, an array or a tuple has no own enumerable
// property and no toJSON: JSON.stringify writes it as the empty object,
// whatever it holds, and the rest of the value keeps its typed serializer.
import { format } from "node:util";

type Reader = typeof String | typeof Number | typeof Boolean;

const readers = new Map<string, Reader>([
  ["title", String],
  ["pages", Number],
]);
const kinds = new Set<Reader>([String, Boolean]);
const counts = new Map<string, number>([["lent", 3]]);
const tags = new Set<string>(["new", "rare"]);

// A member of a record literal, beside typed members.
console.log(JSON.stringify({ t: readers, n: 1 }));
console.log(JSON.stringify({ t: kinds, n: 2 }));
console.log(JSON.stringify({ a: counts, b: tags, c: "x" }));

// An element of an array, alone and beside numbers.
console.log(JSON.stringify([readers, 1]));
console.log(JSON.stringify([kinds, 2]));
console.log(JSON.stringify([counts, counts]));
console.log(JSON.stringify([tags]));

// A declared record type, a nested one, an optional member and a tuple.
interface Shelf {
  label: string;
  index: Map<string, number>;
  seen?: Set<string>;
}
const shelf: Shelf = { label: "north", index: counts };
const full: Shelf = { label: "south", index: counts, seen: tags };
console.log(JSON.stringify(shelf));
console.log(JSON.stringify(full));
console.log(JSON.stringify({ shelves: [shelf, full], total: 2 }));
const pair: [string, Map<string, number>] = ["east", counts];
console.log(JSON.stringify(pair));
const byName: Record<string, Set<string>> = { first: tags, second: new Set<string>() };
console.log(JSON.stringify(byName));

// An arm of a union, in a member and in an element.
const either: { held: Map<string, number> | null }[] = [{ held: counts }, { held: null }];
console.log(JSON.stringify(either));
const mixed: (string | Set<string>)[] = ["a", tags, "b"];
console.log(JSON.stringify(mixed));

// With an indent the empty object stays on its line.
console.log(JSON.stringify({ t: readers, n: [1, 2], u: { v: tags } }, null, 2));
console.log(JSON.stringify([counts, { w: kinds }], null, "\t"));

// The collection is not read: filling it changes nothing.
counts.set("held", 9);
tags.add("signed");
console.log(JSON.stringify({ a: counts, b: tags }), counts.size, tags.size);

// %j writes what JSON.stringify writes.
console.log(format("%j", { t: readers, n: 1 }));
console.log(format("%j|%j", shelf, [tags, 1]));
console.log("%j", full);
