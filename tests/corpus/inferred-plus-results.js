// `+` and `+=` over values of known types: a number from two numeric
// operands (numbers, booleans, null, undefined), a string when either
// operand is a string, a bigint from two bigints, and each of number,
// bigint, and string when an object's own `valueOf` may produce it.

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
// An object converts with ToPrimitive, which calls its own `valueOf`: the
// result may be a number or a bigint, not only a string.
class Boxed {
  constructor(n) {
    this.n = n;
  }
  valueOf() {
    return this.n;
  }
}
const fromValueOf = plus({ valueOf: () => 41 }, 1);
const fromMethod = plus(new Boxed(41), 1);
const fromBigValueOf = plus({ valueOf: () => 41n }, 1n);
console.log(fromValueOf, typeof fromValueOf, fromMethod, typeof fromMethod);
console.log(fromBigValueOf, typeof fromBigValueOf, fromValueOf + fromMethod);
console.log(plus({ toString: () => "x", valueOf: () => 2 }, 3));
// A function stored in an untyped container keeps its parameter untyped for
// the checker while the analysis still sees the object passed to it, whose
// `valueOf` yields a number: `+` may produce one, not only a string.
function addOne(value) {
  return value + 1;
}
const handlers = new Map();
handlers.set("one", addOne);
const fromHandler = addOne({ valueOf: () => 41 });
console.log(fromHandler, typeof fromHandler, fromHandler + 1);
let joined = "";
for (const value of [1, 2, 3]) joined += value;
let sum = 0;
for (const value of [1, 2, 3]) sum += value;
console.log(joined, typeof joined, sum, typeof sum);
