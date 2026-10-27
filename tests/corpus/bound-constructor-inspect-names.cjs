'use strict';
// util.inspect names an object after the function in the first own
// `constructor` property on its prototype chain. Here that function is a
// bound function, whose name ("bound " and the target's name) is built at
// bind time, and the property is replaced after construction, which
// releases the first bound function. The instance keeps the name. The
// targets are anonymous, so the bound names are "bound " and "bound bound ".
const util = require('util');

// Array elements give the functions no name.
const [Point, Pair] = [
  function (x) {
    this.x = x;
  },
  function (a, b) {
    this.a = a;
    this.b = b;
  },
];
Point.prototype.constructor = Point.bind(null);
const p = new Point(1);
console.log(util.inspect(p));

Point.prototype.constructor = Point.bind(null);
const filler = [];
for (let i = 0; i < 200; i++) filler.push('bound '.repeat(i % 5) + i);
console.log(util.inspect(p));
console.log(p);
console.log(filler.length);

// A bound function of a bound function, replaced the same way.
Pair.prototype.constructor = Pair.bind(null).bind(null);
const q = new Pair(1, 2);
Pair.prototype.constructor = Pair.bind(null).bind(null);
console.log(util.inspect(q));
console.log(q);
