// User JavaScript with one R2 construct per rule. With --strict-user-js,
// coverage reports each as the SC81xx error scope B makes it; without the
// flag the report is unchanged.
function Point(x) {
  this.x = x;
}
Point.prototype.norm = function norm() {
  return Math.abs(this.x);
};
const base = { kind: "base" };
const child = {};
Object.setPrototypeOf(child, base);
const box = {};
Object.defineProperty(box, "size", { value: 3, enumerable: false });
function legacy(a) {
  arguments[0] = 2;
  return a;
}
Array.prototype.last = function last() {
  return this[this.length - 1];
};
console.log(new Point(-2).norm(), child.kind, box.size, legacy(1));
