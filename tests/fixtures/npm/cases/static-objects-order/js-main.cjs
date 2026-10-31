// The JavaScript consumer of static-objects-order
// (tests/harness/static-objects-order.test.ts compiles it with the shape overlay on).
const receivers = require("static-objects-order/receivers.js");
const lazy = require("static-objects-order/lazy-user.js");
const vec = require("static-objects-order/vec-user.js");
const early = require("static-objects-order/early-user.js");
const coerce = require("static-objects-order/coerce-user.js");
const loops = require("static-objects-order/loops-user.js");

console.log("start");
console.log(receivers.ns.run("add"), receivers.ns.run("sub"), receivers.ns.reads());
console.log(receivers.ns.proto());
console.log(receivers.ns.early());
console.log(lazy.greet("a"), lazy.greet("b"));
console.log(vec.len2(3, 4));
console.log(early.early());
console.log(coerce.area(3));
console.log(loops.loopStores());
