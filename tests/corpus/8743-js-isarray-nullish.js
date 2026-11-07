// Array.isArray answers from the runtime value's array-ness: null and
// undefined are not arrays, and a literal argument has no effect to run. The
// answer must not depend on evaluating (or storing) the argument, so the
// nullish case answers false exactly as Node does.

console.log(Array.isArray(null), Array.isArray(undefined), Array.isArray(void 0));

const seen = [];
function probe(value) {
  seen.push(value);
  return value;
}

// A computed argument still evaluates for its effects, whatever it answers.
console.log(Array.isArray(probe(7)), seen.join(","));
console.log(Array.isArray(probe([1, 2])), seen.join(","));

console.log(Array.isArray([]), Array.isArray([1, 2]), Array.isArray({ length: 0 }));
console.log(Array.isArray("abc"), Array.isArray(0), Array.isArray(false));

// A variable whose type is only the unit type folds the same way.
const absent = undefined;
const nil = null;
console.log(Array.isArray(absent), Array.isArray(nil));

// The nullish value can come from a call the checker types dynamically.
function acceptsWhatever(value) {
  return value;
}
console.log(Array.isArray(acceptsWhatever(null)), Array.isArray(acceptsWhatever(undefined)));
console.log(Array.isArray(acceptsWhatever([3])), Array.isArray(acceptsWhatever("s")));
