// User JavaScript with one R2 construct per rule. With --strict-user-js,
// coverage reports each as the SC81xx error scope B makes it; without the
// flag the report is unchanged. Constructor functions, their prototypes and
// Object.defineProperty on the objects a program builds compile natively, so
// the constructor-function and shape-mutation rows are the shapes that still
// have no lowering: a class prototype grown at run time, and a bound
// function's construction.
class Meter {}
Meter.prototype.reset = function reset() {
  return 0;
};
function make(value) {
  return value;
}
const bound = new (make.bind(null, 1))();
const base = { kind: "base" };
const child = {};
Object.setPrototypeOf(child, base);
function legacy(a) {
  arguments[0] = 2;
  return a;
}
Array.prototype.last = function last() {
  return this[this.length - 1];
};
console.log(child.kind, legacy(1), bound, new Meter().reset());
