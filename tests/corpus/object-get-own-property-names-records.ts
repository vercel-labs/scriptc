// Object.getOwnPropertyNames over a statically typed record answers the
// record's own keys: the declared fields in declaration order (an absent
// optional field stays out), and for an index signature the declared
// fields then the overflow in own-key order. The answer is the same
// string[] Object.keys builds, and a record that kept undeclared
// properties of its checked source answers Node's full name list.

type Schema = { type: string; minimum?: number; maximum?: number };

const partial: Schema = { type: "number", maximum: 10 };
const partialNames = Object.getOwnPropertyNames(partial);
console.log(partialNames.join(","), partialNames.length);
console.log(Array.isArray(partialNames), typeof partialNames[0], partialNames[0] === "type");

const full: Schema = { type: "string", minimum: 1, maximum: 2 };
console.log(Object.getOwnPropertyNames(full).join(","));
const onlyType: Schema = { type: "boolean" };
console.log(JSON.stringify(Object.getOwnPropertyNames(onlyType)));
console.log(Object.getOwnPropertyNames(full).join("|") === Object.keys(full).join("|"));
console.log(Object.getOwnPropertyNames(full).sort().join(","));
console.log(Object.getOwnPropertyNames(full).map((name) => name.length).join(","));

// Declaration order, not literal order.
type Point = { y: number; x: number; label: string };
const point: Point = { x: 1, y: 2, label: "p" };
const walked: string[] = [];
for (const name of Object.getOwnPropertyNames(point)) walked.push(name);
console.log(walked.join(","), Object.getOwnPropertyNames(point).includes("x"));

// An index signature: declared fields, then the overflow.
const counters: Record<string, number> = { alpha: 1 };
counters["beta"] = 2;
counters["gamma"] = 3;
console.log(Object.getOwnPropertyNames(counters).join(","), Object.getOwnPropertyNames(counters).length);

// A record built by a checked conversion keeps undeclared own properties.
const kept = JSON.parse('{"a":1,"extra":true,"b":2}') as { a: number };
console.log(Object.getOwnPropertyNames(kept).join(","), Object.getOwnPropertyNames(kept).length);
const closed = JSON.parse('{"a":1}') as { a: number };
console.log(Object.getOwnPropertyNames(closed).join(","));

// The array is a fresh, writable string[].
const fresh = Object.getOwnPropertyNames(full);
fresh.push("extra");
console.log(fresh.length, Object.getOwnPropertyNames(full).length);
