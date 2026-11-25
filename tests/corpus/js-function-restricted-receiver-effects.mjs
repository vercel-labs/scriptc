// Reading `caller` or `arguments` from a function value throws the
// restricted-property TypeError only after the receiver expression has been
// evaluated: its effects run first, and an exception it throws is the one
// the program sees.
function inner() {}
let steps = 0;
function step() {
  steps++;
  return steps;
}
function boom() {
  throw new RangeError("receiver threw");
}
function read(label, f) {
  try {
    f();
    console.log(label, "returned");
  } catch (error) {
    console.log(label, error.constructor.name, error instanceof TypeError, steps);
  }
}
read("comma caller", () => (step(), inner).caller);
read("comma arguments", () => (step(), inner).arguments);
read("receiver throws", () => (boom(), inner).caller);
read("plain", () => inner.caller);
console.log("steps", steps);

// The own-property probe with a key known only at run time still answers
// every key but `prototype`.
for (const key of ["name", "length", "caller", "arguments", "missing"]) {
  console.log(key, inner.hasOwnProperty(key));
}
