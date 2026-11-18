// A `+` over an optional string is the string the checker types when the
// value is present and NaN when it is absent: a JSDoc union annotation on
// the binding does not make the checker's type for its reads honest, so a
// read keeps the union and answers the value Node answers.
/** @param {string} [text] */
function describe(text) {
  /** @type {string | number} */
  const sum = text + 1;
  console.log(typeof sum, sum);
}

describe();
describe("a");

// The same through parentheses: the sum is still the recorded arithmetic
// result.
/** @param {string} [text] */
function parenthesized(text) {
  /** @type {string | number} */
  const sum = (text + 1);
  console.log(sum === sum, String(sum));
}

parenthesized();
parenthesized("b");

// A `let` read before a string is assigned holds the first value.
/** @param {string} [text] */
function reassigned(text) {
  /** @type {string | number} */
  let sum = text + 1;
  console.log(sum);
  sum = "later";
  console.log(sum.toUpperCase());
}

reassigned();
reassigned("c");
