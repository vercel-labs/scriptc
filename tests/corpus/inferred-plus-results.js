// `+` and `+=` over values of known types: a number from two numeric
// operands (numbers, booleans, null, undefined), a string when either
// operand is a string or an object, a bigint from two bigints, and either
// when an operand is untyped.

class Counter {
  constructor(start) {
    this.total = start;
    this.label = "c" + start;
  }
  add(step) {
    this.total += step;
    this.label += step;
    return this;
  }
}
function plus(a, b) {
  return a + b;
}
const counter = new Counter(1).add(2).add(3);
console.log(counter.total, typeof counter.total, counter.label, typeof counter.label);
console.log(plus(1, 2), plus(true, null), plus(undefined, 1), plus(1, "x"), plus("x", false));
console.log(plus({ toString: () => "obj" }, 1), plus([1, 2], 3), plus(10n, 5n));
const parsed = JSON.parse('{"n": 4, "s": "4"}');
console.log(plus(parsed.n, 1), plus(parsed.s, 1));
let joined = "";
for (const value of [1, 2, 3]) joined += value;
let sum = 0;
for (const value of [1, 2, 3]) sum += value;
console.log(joined, typeof joined, sum, typeof sum);
