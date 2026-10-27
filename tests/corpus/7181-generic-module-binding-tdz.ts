// A module-scope generic arrow binding is in its temporal dead zone until
// its declaration runs: a hoisted function or an earlier closure that calls
// it during module evaluation throws a ReferenceError, and calls made after
// the declaration reach the function. A `var` binding is undefined until
// then: the call's arguments run, then it throws "is not a function".
function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function early(): number {
  return id(1);
}
const before = (): string => wrap("b");

try {
  console.log(early());
} catch (error) {
  console.log(describe(error));
}
try {
  console.log(before());
} catch (error) {
  console.log(describe(error));
}

const id = <T>(x: T): T => x;
let wrap = <T>(x: T): string => `[${String(x)}]`;

console.log(early(), before(), id("direct"), wrap(2));

function later(): string {
  return wrap(id(3));
}
console.log(later());

function callMissing(): number {
  return missing(log("argument"));
}
function log(text: string): number {
  console.log(text);
  return 1;
}
try {
  console.log(callMissing());
} catch (error) {
  console.log(describe(error));
}
var missing = <T>(x: T): T => x;
console.log(callMissing(), missing(5));
