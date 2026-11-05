// Namespace-style modules whose rewrites must keep evaluation and load
// order, used from TypeScript (js-main.cjs is the JavaScript consumer).
import { ns } from "static-objects-order/receivers.js";
import { greet } from "static-objects-order/lazy-user.js";
import { len2 } from "static-objects-order/vec-user.js";
import { early } from "static-objects-order/early-user.js";
import { area } from "static-objects-order/coerce-user.js";
import { loopStores } from "static-objects-order/loops-user.js";

console.log("start");
console.log(ns.run("add"), ns.run("sub"), ns.reads());
console.log(ns.proto());
console.log(ns.early());
console.log(greet("a"), greet("b"));
console.log(len2(3, 4));
console.log(early());
console.log(area(3));
console.log(loopStores());
