// `const view = value as T` where T names a member the value's own layout
// does not hold builds a copy of the value, so a write through the binding
// would land on that copy while Node erases the assertion and writes the
// original object. Refused by name instead of diverging; reads of such a
// copy are equal either way and stay allowed.
interface Base {
  a: number;
}
const base: Base = { a: 1 };

// File scope: the copy would live in the module binding.
const widened = base as { a: number; extra?: string };
widened.extra = "x";

// A function's local binding takes the same path.
function widen(b: Base): void {
  const local = b as { a: number; extra?: string };
  local.extra = "y";
}

// A union operand whose arms hold no such member copies too.
function widenUnion(u: Base | { a: number; b: number }): void {
  const view = u as { extra?: string };
  view.extra = "z";
}

widen(base);
widenUnion(base);
