// `binding && rest` over a `let` only a closure assigns compiles: the pair
// answers `rest` once the binding holds a value. These neighbours do not,
// and say so at build time.

let seen: { n: number } | null = null;
function mark(): void {
  seen = { n: 3 };
}
function word(): string | undefined {
  return "w";
}
function flag(): boolean | undefined {
  return true;
}

mark();
// `||` and `??` answer the binding itself once it holds a value, and the
// checker typed the pair (and the binding below) as the right operand alone.
const either = seen || word();
const fallback = seen ?? word();
console.log(typeof either, typeof fallback);

// Nothing assigns this one: the checker is right that it is null, and the
// right operand has no place in a pair that is always null.
let never: { n: number } | null = null;
const none = never && flag();
console.log(typeof none);
