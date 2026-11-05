// In sloppy-mode functions, `this` is the global object when the function is
// called with undefined or null as its receiver: by a plain call, by a
// detached method, and through call and apply. Strict functions and arrows
// keep the receiver they get.

// Before anything else reads the global object.
function readConsole() {
  return typeof this.console.log === "function" && this.console === console;
}
console.log(readConsole(), readConsole.call(null), readConsole.call({ console: 1 }));

// Builtins read through the global `this`, directly and through a variable.
function readBuiltins() {
  return [this.Array === Array, this.JSON === JSON, typeof this.setTimeout];
}
function aliasedRoot() {
  var root = this;
  return root.Object === Object && typeof root.Promise;
}
console.log(readBuiltins(), aliasedRoot());

// Builtins read through the global `this` by literal keys.
function readByLiteral() {
  var root = this;
  return [this["Map"] === Map, root["Math"] === Math, typeof this[`Set`], this[0]];
}
console.log(readByLiteral(), readByLiteral.call({ Map: 1 })[0]);

function receiver() {
  return this;
}
function kind() {
  return typeof this;
}
function strictReceiver() {
  "use strict";
  return this;
}

console.log(receiver() === globalThis, kind());
console.log(receiver.call(undefined) === globalThis, receiver.call(null) === globalThis);
console.log(receiver.apply(undefined, []) === globalThis, receiver.apply(null) === globalThis);
console.log(strictReceiver() === undefined, strictReceiver.call(null) === null);

const holder = {
  name: "holder",
  self() {
    return this;
  },
};
const detached = holder.self;
console.log(holder.self() === holder, detached() === globalThis);

function outer() {
  function inner() {
    return this;
  }
  return inner() === globalThis;
}
console.log(outer(), outer.call({ name: "o" }));

globalThis.sloppyMarker = 42;
function readMarker() {
  return this.sloppyMarker;
}
console.log(readMarker(), readMarker.call(undefined), readMarker.call({ sloppyMarker: 7 }));

const arrow = () => this;
console.log(arrow() === module.exports, arrow.call(null) === module.exports);
