// A function value answers Object.prototype's own-property probe from its
// dynamic view: the closure's own-property table first, then `name` and
// `length`, and nothing else. Compiled functions are strict-mode function
// objects, so `caller` and `arguments` are not own properties, and reading
// either one reaches Function.prototype's restricted accessor, which throws.
function add(a, b) {
  return a + b;
}
const arrow = (x) => x;
const method = {
  m(a) {
    return a;
  },
}.m;
function* gen() {
  yield 1;
}
const probes = ["caller", "arguments", "name", "length", "callee", "missing"];
for (const key of probes) {
  console.log("add", key, add.hasOwnProperty(key));
  console.log("arrow", key, arrow.hasOwnProperty(key));
  console.log("method", key, method.hasOwnProperty(key));
}
console.log("noarg", add.hasOwnProperty());
console.log("before", add.hasOwnProperty("tag"));
Object.defineProperty(add, "tag", { value: 7, enumerable: true });
console.log("after", add.hasOwnProperty("tag"), add.tag);
console.log("still", add.hasOwnProperty("caller"), arrow.hasOwnProperty("caller"));
function restricted(label, read) {
  try {
    const value = read();
    console.log(label, "returned", value === undefined ? "undefined" : typeof value);
  } catch (error) {
    console.log(label, "threw", error.constructor.name, error instanceof TypeError);
  }
}
restricted("add.caller", () => add.caller);
restricted("add.arguments", () => add.arguments);
restricted("arrow.caller", () => arrow.caller);
restricted("method.arguments", () => method.arguments);
restricted("gen.caller", () => gen.caller);
restricted("after-define", () => add.caller);
