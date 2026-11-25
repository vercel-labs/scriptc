// A function's prototype written from an object literal: the instance
// inherits its members and instanceof answers against the one object the
// literal became.
"use strict";

function F() {}
F.prototype = {
  a: 1,
  greet: function () {
    return "hi " + this.a;
  },
};
const f = new F();
console.log(f.a, f.greet(), f instanceof F, Object.getPrototypeOf(f) === F.prototype);

F.prototype.b = 2;
console.log(new F().b, Object.getOwnPropertyNames(F.prototype).sort().join(","));
