"use strict";

function forward(value: { count: number }): { count: number } { return value; }
function fresh(count: number): { count: number } { return { count }; }
function frozen(count: number): Readonly<{ count: number }> { return Object.freeze({ count }); }

// Alternating ordinary and frozen allocations must not inherit the prior
// occupant's integrity when optimized allocation slots are reused.
let frozenCount = 0;
let mutableCount = 0;
let identities = 0;
for (let i = 0; i < 256; i++) {
  const value = fresh(i);
  if (Object.isFrozen(value)) throw new Error("fresh record inherited integrity");
  const alias = forward(value);
  if (alias === value) identities++;
  Object.freeze(value);
  if (Object.isFrozen(forward(alias))) frozenCount++;
  const next = fresh(i + 1);
  next.count++;
  if (!Object.isFrozen(next)) mutableCount++;
  if (!Object.isFrozen(frozen(i))) throw new Error("returned record lost integrity");
}
console.log("allocations", frozenCount, mutableCount, identities);

let current = fresh(1);
Object.freeze(current);
current = fresh(2);
current.count = 3;
console.log("reassigned", current.count, Object.isFrozen(current));

const held = frozen(4);
function inspect(value: unknown): boolean { return Object.isFrozen(value); }
for (let i = 0; i < 16; i++) {
  if (!inspect(held)) throw new Error("temporary view lost integrity");
}
console.log("held", held.count, inspect(held));
