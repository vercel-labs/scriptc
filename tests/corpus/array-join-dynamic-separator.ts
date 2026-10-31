// Array.prototype.join over a checked-dynamic separator: only the
// undefined VALUE means the default comma; every other value is ToString
// (null prints "null", numbers and booleans their text), and the
// separator expression evaluates once.

function joinWith(sep: any): string {
  return ["a", "b", "c"].join(sep);
}
console.log(joinWith(undefined));
console.log(joinWith(null));
console.log(joinWith("-"));
console.log(joinWith(0));
console.log(joinWith(false));
console.log(joinWith(""));

const held: any = "+";
console.log(["x", "y"].join(held), ["x", "y"].join(undefined));
const numbers = [1, 2, 3];
console.log(numbers.join(held), numbers.join(null as any));

let reads = 0;
function separator(): any {
  reads += 1;
  return "/";
}
console.log(["p", "q"].join(separator()), reads);

// A dynamic separator that turns out to be undefined keeps the default.
function maybe(flagValue: boolean): any {
  return flagValue ? "-" : undefined;
}
console.log(["m", "n"].join(maybe(true)), ["m", "n"].join(maybe(false)));
