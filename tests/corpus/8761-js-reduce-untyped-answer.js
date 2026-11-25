// A reduce callback's answer is what the accumulator becomes, whatever the
// initial value's type says. A function that returns nothing answers
// undefined, and a boolean replaces a number; both are the checker's
// inference being narrower than the program (a diagnosis it already made),
// so the reduction accumulates the checked-dynamic value JavaScript
// produces instead of miscasting it to the initial value's type.
//
// The value is therefore only reachable through a checked-dynamic boundary:
// the checker still types the call with the initial value's type, and
// storing a value the checker never saw would be exactly the type lie this
// compilation refuses ("types don't lie").

/** @param {unknown} value */
function reveal(label, value) {
  console.log(label, value === undefined ? "undefined" : typeof value, value);
}

let calls = 0;
function countOnly() {
  calls++;
}

[11, 12].reduce(countOnly, 1);
console.log("called", calls);

reveal("void", [11, 12].reduce(countOnly, 1));
console.log("called", calls);

function alwaysTrue() {
  calls++;
  return true;
}
console.log([11, 12].reduceRight(alwaysTrue, 11), calls);

const numbers = [1, 2, 3];
const drained = numbers.slice(0, 0);
[5].reduce(countOnly);
console.log("seed", calls);
reveal("seeded", drained.reduce(countOnly, 0));
reveal("no-seed", [7, 8].reduce(countOnly));

// A callback that answers the accumulator's own type keeps the typed loop,
// and a callback that names its parameters still sees every value.
function sum(acc, value) {
  return acc + value;
}
console.log(numbers.reduce(sum, 0), numbers.reduceRight(sum, 0));

let seen = "";
function describe(acc, value, index, array) {
  seen += acc + ":" + value + ":" + index + ":" + array.length + ";";
  return acc + value;
}
console.log(numbers.reduce(describe, 0));
console.log(seen);

// The dynamic accumulator keeps the empty-array rule: a missing initial value
// with an empty array still throws the TypeError Node throws.
function report(label, fn) {
  try {
    fn();
    console.log(label, "no-throw");
  } catch (error) {
    console.log(label, error instanceof TypeError ? "TypeError" : "other");
  }
}
report("empty", () => drained.reduce(countOnly));
