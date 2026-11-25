// A built-in global named through the global object is the built-in its
// bare name names (corpus 9415). A call of one the program assigns is
// refused when the program is built: the call would reach the built-in,
// not the assigned function.
globalThis.structuredClone = (<T,>(value: T): T => value) as typeof structuredClone;
console.log(globalThis.structuredClone({ a: 1 }).a);
export {};
