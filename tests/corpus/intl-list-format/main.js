// @requires-icu
// Intl.ListFormat over ICU: format() steps an iterable whose elements must
// already be strings, and a non-string element is Node's TypeError quoting
// V8's side-effect-free text for the value.

const conjunction = new Intl.ListFormat("en", { type: "conjunction", style: "long" });
console.log(JSON.stringify(conjunction.format([])));
console.log(JSON.stringify(conjunction.format(["a"])));
console.log(JSON.stringify(conjunction.format(["a", "b"])));
console.log(JSON.stringify(conjunction.format(["a", "b", "c"])));
console.log(JSON.stringify(conjunction.format(new Set(["x", "y"]))));
console.log(JSON.stringify(conjunction.format("abc")));
console.log(JSON.stringify(conjunction.format()));

console.log(JSON.stringify(new Intl.ListFormat("en", { type: "disjunction" }).format(["a", "b", "c"])));
console.log(JSON.stringify(new Intl.ListFormat("en", { type: "unit" }).format(["5 pounds", "12 ounces"])));
console.log(JSON.stringify(new Intl.ListFormat("en", { style: "short" }).format(["a", "b", "c"])));
console.log(JSON.stringify(new Intl.ListFormat("en", { style: "narrow" }).format(["a", "b", "c"])));

function message(formatter, value) {
  try {
    formatter.format([value]);
    return "no throw";
  } catch (error) {
    return error.constructor.name + ": " + error.message;
  }
}

for (const value of [1, 12.5, true, null, undefined, 10n, Symbol("s"), ["a"], { a: 1 }]) {
  console.log(message(conjunction, value));
}

try {
  new Intl.ListFormat("en", { type: "nope" });
} catch (error) {
  console.log(error.constructor.name + ": " + error.message);
}

// An element with an own toString takes the [object Object] branch (the
// renderer asks whether one exists, borrowing the member read).
console.log(message(conjunction, { toString() { return "text"; } }));

// An element that is not a string closes the iterator with return() before
// the TypeError.
const closing = {
  [Symbol.iterator]() {
    let index = 0;
    return {
      next: () => ({ done: index > 1, value: index++ === 0 ? "ok" : 5 }),
      return: () => {
        console.log("iterator closed");
        return { done: true };
      },
    };
  },
};
try {
  conjunction.format(closing);
} catch (error) {
  console.log(error.constructor.name + ": " + error.message);
}

// A value that is not iterable is V8's TypeError.
for (const value of [42, { a: 1 }, { next: () => ({ done: true }) }, null]) {
  try {
    conjunction.format(value);
  } catch (error) {
    console.log(error.constructor.name + ": " + error.message);
  }
}

// Null and primitive options are Node's invalid_argument TypeError.
for (const options of [null, 5, "x", true]) {
  try {
    new Intl.ListFormat("en", options);
  } catch (error) {
    console.log("options:", error.constructor.name + ": " + error.message);
  }
}
