// The `__proto__` initializer of a table literal runs once, when the module's
// exports object is built, and its result is that object's prototype.
let evaluations = 0;
function makePrototype() {
  evaluations += 1;
  return { tag: "shared" };
}
module.exports = { __proto__: makePrototype(), answer: 42, evaluations: () => evaluations };
