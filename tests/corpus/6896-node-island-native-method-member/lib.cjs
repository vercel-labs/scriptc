"use strict";
// Island objects that hold whatever functions they are given.
function make(n) {
  return { n, label: `item-${n}`, cb: null, fmt: null, nested: { run: null } };
}
function callFromIsland(o, ...args) {
  return o.cb(...args);
}
module.exports = { make, callFromIsland };
