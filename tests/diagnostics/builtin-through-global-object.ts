// A built-in global named through the global object is the built-in its
// bare name names (corpus 9415). Three forms are refused when the program
// is built: a call of one the program assigns (the call would reach the
// built-in, not the assigned function), a read of one that has no value a
// compiled program can hold (as its bare name is), and such a one taken
// from the global object by a pattern.
globalThis.structuredClone = (<T,>(value: T): T => value) as typeof structuredClone;
console.log(globalThis.structuredClone({ a: 1 }).a);

const later = globalThis.setTimeout;
const { queueMicrotask: soon, URL: Address } = globalThis;
console.log(typeof later, typeof soon, typeof Address);
export {};
