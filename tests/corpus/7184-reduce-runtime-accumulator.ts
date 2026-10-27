// Array reduce keeps the values its callback and initial value produce at
// run time: an initial value read from a missing element is undefined, a
// callback can produce another primitive through `??`, and a parenthesized
// callback widens like a bare one.
const noStrings: string[] = [];
const noNumbers: number[] = [];

const fromMissingInit = ([] as number[]).reduce((_acc, _value) => "ok", noStrings[0]);
console.log(typeof fromMissingInit, fromMissingInit);

const nonEmpty = [1, 2].reduce((acc, value) => acc + value, noNumbers[0]);
console.log(typeof nonEmpty, nonEmpty);

const fallback = [1, 2].reduce((_acc, _value) => noNumbers[0] ?? "fallback");
console.log(typeof fallback, fallback);

const parenthesized = [1, 2].reduce((acc, x) => (x === 1 ? noStrings[0] : acc + "!"), "");
console.log(parenthesized);

const wrapped = [1, 2].reduce(((acc, x) => (x === 1 ? noStrings[0] : acc + "!")), "");
console.log(wrapped);

const right = ["a", "b"].reduceRight((acc, s) => acc + s, noStrings[0]);
console.log(right);
