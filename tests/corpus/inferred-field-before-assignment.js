// Code that sees an instance before its constructor stores a field (a
// helper called with `this`, a local holding `this`, a base constructor
// calling an overridden method) reads undefined from the field.
const seen = [];
function inspect(point) {
  seen.push(point.x + 1);
}
class Point {
  constructor(x) {
    inspect(this);
    this.x = x;
  }
}
class Later {
  constructor(x) {
    const self = this;
    report(self);
    this.x = x;
  }
}
function report(value) {
  seen.push(value.x === undefined ? "absent" : value.x * 2);
}
class Base {
  constructor() {
    this.describe();
  }
  describe() {}
}
class Derived extends Base {
  constructor(x) {
    super();
    this.x = x;
  }
  describe() {
    seen.push(typeof this.x);
  }
}
const a = new Point(1);
const b = new Later(2);
const c = new Derived(3);
console.log(seen.join(","), a.x + b.x + c.x);
