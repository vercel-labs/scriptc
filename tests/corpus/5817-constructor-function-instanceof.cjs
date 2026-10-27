// `this instanceof F` in a constructor function, in a program that uses no
// EventEmitter or stream constructor value: the call-without-new idiom
// returns a new instance, and instanceof follows the function's prototype.
"use strict";
function Glob(pattern) {
  if (!(this instanceof Glob)) return new Glob(pattern);
  this.pattern = pattern;
}
Glob.prototype.describe = function () {
  return `glob ${this.pattern}`;
};
const called = Glob("*.ts");
const constructed = new Glob("*.js");
console.log(called.describe(), constructed.describe());
console.log(called instanceof Glob, {} instanceof Glob, Object.create(Glob.prototype) instanceof Glob);
