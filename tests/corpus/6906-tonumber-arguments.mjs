// Arguments that the global number functions convert with ToNumber, in a
// JavaScript file where they arrive as strings, booleans, null, undefined
// or dynamic values: isNaN, isFinite, Math functions and
// String.fromCharCode match Node for each.
console.log(isNaN("12"), isNaN("abc"), isNaN(true), isNaN(null), isNaN(undefined));
console.log(isFinite("12"), isFinite("abc"), isFinite(true), isFinite(null), isFinite(undefined));
console.log(Math.floor("3.7"), Math.max("4", 2), Math.abs(false), Math.sqrt(null), String.fromCharCode("65", true));

const parsed = JSON.parse('["12", " 0x10 ", "", "1e400", true, null, {}, [], [7]]');
for (const value of parsed) console.log(JSON.stringify(value), isNaN(value), isFinite(value), Math.trunc(value));

let calls = "";
const boxed = { valueOf: () => ((calls += "v"), 4.5), toString: () => ((calls += "s"), "9") };
console.log(isFinite(boxed), isNaN(boxed), Math.round(boxed), calls);

class LruCache {
  constructor(config) {
    this.maxAge = config.maxAge;
  }
  hasMaxAge() {
    return isFinite(this.maxAge);
  }
}
console.log(new LruCache({ maxAge: 1000 }).hasMaxAge(), new LruCache({}).hasMaxAge());

for (const value of [Symbol("s"), 10n]) {
  try {
    isFinite(value);
  } catch (e) {
    console.log(e instanceof TypeError, e.message);
  }
}

// A conditional argument converts whichever branch it takes.
for (const flag of [true, false]) {
  console.log(isFinite(flag ? "12" : "abc"), isNaN(flag ? null : "x"), Math.floor(flag ? "3.7" : true));
}

// Every argument is evaluated before any converts, as in Node: valueOf runs
// after the last argument, and an argument that throws stops the call
// before any conversion.
let order = "";
const valued = (name, n) => ({ valueOf: () => ((order += "v" + name), n) });
const arg = (name, n) => ((order += "e" + name), valued(name, n));
console.log(Math.max(arg("a", 1), arg("b", 5), arg("c", 3)), order);
order = "";
console.log(Math.pow(arg("a", 2), arg("b", 10)), order);
order = "";
console.log(Math.hypot(arg("a", 3), ...[4], arg("c", 12)), order);
order = "";
console.log(String.fromCharCode(arg("a", 72), arg("b", 105)), order);
order = "";
try {
  Math.max(
    arg("a", 1),
    (() => {
      order += "throw";
      throw new Error("boom");
    })(),
  );
} catch (e) {
  console.log(e.message, order);
}
order = "";
try {
  Math.min(
    {
      valueOf() {
        order += "x";
        throw new TypeError("first");
      },
    },
    arg("b", 2),
  );
} catch (e) {
  console.log(e.message, order);
}

// A spread reads its elements where it is evaluated, before an earlier
// argument's valueOf runs.
const values = [1, 2];
const mutator = {
  valueOf() {
    values[0] = 100;
    values.push(50);
    return 3;
  },
};
console.log(Math.max(mutator, ...values), values.join(","));
const more = [4];
const resetter = {
  valueOf() {
    more[0] = -1;
    return 0;
  },
};
console.log(Math.hypot(resetter, ...more, 3), more.join(","));
