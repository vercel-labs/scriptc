// A function-local class is a new class at each evaluation of its
// declaration: instances from separate calls of the factory have different
// prototypes, while instances from one call share theirs.
function make() {
  class Local {
    tag = "l";
  }
  return new Local();
}
const first: unknown = make();
const second: unknown = make();
console.log(Object.getPrototypeOf(first) === Object.getPrototypeOf(second));
console.log(Object.getPrototypeOf(first) === Object.getPrototypeOf(first));
function pair() {
  class Twin {
    n = 1;
  }
  return [new Twin(), new Twin()];
}
const [t1, t2] = pair().map((value): unknown => value);
const [t3] = pair().map((value): unknown => value);
console.log(Object.getPrototypeOf(t1) === Object.getPrototypeOf(t2));
console.log(Object.getPrototypeOf(t1) === Object.getPrototypeOf(t3));
