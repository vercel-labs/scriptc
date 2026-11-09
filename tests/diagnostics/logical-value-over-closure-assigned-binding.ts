// `binding && rest` over a `let` only a closure assigns compiles: the pair
// answers `rest` once the binding holds a value. The `||` neighbour and the
// always-null `&&` do not, and say so at build time.

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
// `||` and `??` answer the binding itself once it holds a value, and the checker typed the pair as the right
// operand alone. `??` is not refused: it builds, and stops with a named TypeError when the binding holds a value.
const either = seen || word();
const fallback = seen ?? word();
console.log(typeof either, typeof fallback);

// Nothing assigns this one: the checker is right that it is null, and the
// right operand has no place in a pair that is always null.
let never: { n: number } | null = null;
const none = never && flag();
console.log(typeof none);
