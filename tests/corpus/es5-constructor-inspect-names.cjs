// util.inspect names objects built by plain constructor functions after
// the constructor their prototype chain records, as Node does.
'use strict';
const util = require('util');
function Point(x, y) {
  this.x = x;
  this.y = y;
}
Point.prototype.norm = function () {
  return Math.hypot(this.x, this.y);
};
const p = new Point(3, 4);
console.log(p, p.norm());
p.z = 0;
console.log(p);
function Empty() {}
console.log(new Empty(), [new Empty()], { inner: new Empty() });
console.log(util.inspect(new Point(1, 2)));
console.log(`${util.inspect({ list: [new Point(0, 1)] })}`);
// A subclass whose prototype was replaced without a constructor reports
// the nearest constructor on the chain.
function Base(n) {
  this.n = n;
}
function Derived(n) {
  Base.call(this, n);
  this.extra = true;
}
Derived.prototype = Object.create(Base.prototype);
console.log(new Derived(1));
Derived.prototype.constructor = Derived;
console.log(new Derived(2));
// A replaced prototype object without a constructor prints plainly.
function Plain() {
  this.v = 1;
}
Plain.prototype = { get() { return this.v; } };
console.log(new Plain());
const made = Object.create(Point.prototype);
made.x = 9;
console.log(made);
