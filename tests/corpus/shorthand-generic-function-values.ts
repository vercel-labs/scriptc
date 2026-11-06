// A generic function named in object-literal SHORTHAND (`{ fn }`) is the
// same value as the long form (`{ fn: fn }`) and as the bare identifier:
// JavaScript erases type parameters, so an unpinned reference is the
// declaration's ONE erased instance, and a reference whose destination
// completes a signature is that signature's monomorphized instance.

function identity<T>(value: T): T {
  return value;
}

// No pinning context: the erased function every instantiation calls.
const shorthand = { identity };
const long = { identity: identity };
console.log(typeof shorthand.identity, shorthand.identity(5), shorthand.identity("text"));
console.log(typeof long.identity, long.identity(5), long.identity("text"));

// One function object per declaration: the shorthand, the long form and the
// bare identifier all name the same function.
console.log(shorthand.identity === long.identity, shorthand.identity === identity);

// A record crossing the erased boundary boxes as a live capsule, so it comes
// back as the same object.
const row = { id: 1, tags: ["a"] };
console.log(shorthand.identity(row) === row, shorthand.identity([row])[0] === row);

// A typed destination pins the shorthand's signature exactly as it pins the
// long form's: the slot's one concrete call signature monomorphizes the
// value. The pinned value and the declaration are one function object.
function first<T>(values: T[]): T {
  return values[0]!;
}
const pinned: { first: (values: number[]) => number } = { first };
console.log(typeof pinned.first, pinned.first([4, 5]), pinned.first([4, 5]) === 4);
console.log(pinned.first === first);

// A call argument's slot pins the shorthand the same way.
function pick<T>(values: T[]): T {
  return values[0]!;
}
function render(slot: { pick: (values: string[]) => string }): string {
  return slot.pick(["x", "y"]);
}
console.log(render({ pick }));

// A generic with a constrained parameter monomorphizes through the shorthand
// too: the pinned instance keeps the constraint's call signature.
function join<T extends string | number>(text: T): string {
  return `v:${text}`;
}
const formatted: { join: (text: number) => string } = { join };
console.log(formatted.join(42), formatted.join(42.5));
