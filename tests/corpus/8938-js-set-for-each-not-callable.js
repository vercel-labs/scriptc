// Set.prototype.forEach with a callback that is not a function: Node's
// `<value> is not a function`, with the value's type prefix.
const reported = (value) => {
  try {
    new Set([1]).forEach(value);
    return "no error";
  } catch (error) {
    return error.name + ": " + error.message;
  }
};
console.log(reported(0));
console.log(reported(-1.5));
console.log(reported({}));
console.log(reported([]));
console.log(reported(null));
console.log(reported(undefined));
console.log(reported("x"));
console.log(reported(Symbol("s")));
console.log(reported(true));
console.log(reported(10n));
console.log(reported(/re/));

// A callable callback still visits (value, value, set) in insertion order.
const seen = [];
new Set(["a", "b"]).forEach((value, key, set) => {
  seen.push([value, key, set.size]);
});
console.log(JSON.stringify(seen));

// An untyped receiver's non-callable callback throws the same error.
const untyped = new Set([1, 2]);
console.log(reported2(untyped, 0));
function reported2(set, value) {
  try {
    set.forEach(value);
    return "no error";
  } catch (error) {
    return error.name + ": " + error.message;
  }
}
