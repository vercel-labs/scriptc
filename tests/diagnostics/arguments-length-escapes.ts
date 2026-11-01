// `arguments.length` in a function expression bound to a variable folds to
// the declared count. That is exact for a direct call and for a reference
// whose expected function type passes the same count (corpus
// typed-arguments-length-calls), but a reference with no function type or
// with a different count makes the constant wrong: the value can be called
// later with any number of arguments. Those reads fence.

// Boxed to a dynamic value, then called with four arguments: Node answers 4.
const boxed = function (a: string, b: string, c: string): number {
  return arguments.length;
};
const asAny: any = boxed;
console.log("boxed", boxed("a", "b", "c"), asAny("a", "b", "c", "d"));

// Stored in a wider function type: calls through the slot pass two.
const narrow = function (a: number): number {
  return arguments.length;
};
const wider: (a: number, b: number) => number = narrow;
console.log("wider", wider(1, 2));

// Stored in a slot with an optional tail: the count varies per call.
const optional = function (a: number): number {
  return arguments.length;
};
const varies: (a: number, b?: number) => number = optional;
console.log("varies", varies(1), varies(1, 2));

// Copied to another binding: the copy can be boxed and called with any
// count later, so the constant is no longer the whole story.
const copied = boxed;
console.log("copied", copied("a", "b", "c"));

// Read through `.call`: the value escapes, since `.call` and `.apply` pass any
// count. Reading `.name` or `.length` alone is no escape (corpus
// typed-arguments-length-calls).
const viaCall = function (a: number): number {
  return arguments.length;
};
console.log("call", viaCall.call(undefined, 1), viaCall.name);
