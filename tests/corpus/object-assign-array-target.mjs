// Object.assign onto an array: the source's own enumerable members arrive on
// the array itself. A named key becomes a named property beside the
// elements, an index key writes the element, `length` sets the length, and
// the result is the array that was passed.

const labelled = Object.assign([], { unit: "kg", marks: [] });
console.log(labelled.unit, labelled.marks.length, labelled.length, Array.isArray(labelled));
console.log(Object.keys(labelled).join(","), "unit" in labelled, Object.hasOwn(labelled, "marks"));
console.log(JSON.stringify(labelled), typeof labelled.marks);

const extra = { origin: ["north", "east"] };
const weights = Object.assign(new Array(), extra);
weights.push(4, 9);
console.log(weights.origin.join("|"), weights.length, weights.join("+"), Object.keys(weights).join(","));
console.log(weights.origin === extra.origin);

// Index keys and `length` are element writes.
const slots = Object.assign([], { 0: "first", 2: "third" });
console.log(slots.length, slots[0], slots[1], slots[2], 1 in slots, Object.keys(slots).join(","));
const trimmed = Object.assign([], ["a", "b", "c"], { length: 2 });
console.log(trimmed.length, trimmed.join("|"));
const spelled = Object.assign([], "ok");
console.log(spelled.length, spelled.join("|"));

// Several sources, a parsed source, a getter and a symbol key.
const tag = Symbol("tag");
const parsed = JSON.parse('{"scale":3,"notes":["dry"]}');
const mixed = Object.assign(
  [],
  { depth: 1 },
  parsed,
  {
    get live() {
      return 7;
    },
  },
  { [tag]: "t" },
);
console.log(mixed.depth, mixed.scale, mixed.notes.join("|"), mixed.live, mixed[tag], mixed.length);
const seen = [];
for (const key in mixed) seen.push(key);
console.log(seen.join(","));

// The array still behaves as one.
const queue = Object.assign([], { owner: "dock" });
queue.push("crate");
queue.unshift("pallet");
console.log(queue.length, queue.join("|"), [...queue].length, queue.owner, queue.map((item) => item.length).join(","));
console.log(Object.entries(queue).map(([key, value]) => `${key}=${value}`).join(";"));

// Nothing to copy leaves the array as it was.
const bare = Object.assign([], {});
console.log(bare.length, Object.keys(bare).length);

// A frozen array refuses the member, as any frozen object does.
const fixed = Object.freeze([]);
try {
  Object.assign(fixed, { late: 1 });
  console.log("assigned");
} catch (error) {
  console.log(error instanceof TypeError, "late" in fixed);
}
