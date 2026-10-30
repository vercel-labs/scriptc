// A JavaScript function that calls a callback inside its options object
// with records it builds, in another key order than the TypeScript literals
// of the callback's parameter type.
export function each(options) {
  options.visit({ a: 1, b: 2 });
  options.visit({ a: 3, b: 4 });
}
