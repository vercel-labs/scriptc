// @requires-libnode
// Native functions stored on island objects and called as methods from
// native code: the island object is the receiver, arguments and results
// cross both ways, throws propagate, and island code calling the same
// member sees the same function.
import { requireModule } from "@scriptc/node";

const { callFromIsland, make } = requireModule("./lib.cjs");

const o = make(3);
o.cb = (a, b) => o.n * a + b;
console.log("arrow", o.cb(2, 1), callFromIsland(o, 2, 1));

o.fmt = function (prefix) {
  return `${prefix}:${this.label}:${this.n}`;
};
console.log("this", o.fmt("p"), o.fmt.call(make(9), "q"));

o.nested.run = (x) => [x, x * 2];
console.log("nested", o.nested.run(4).join(","));

o.cb = () => {
  throw new RangeError("from native member");
};
try {
  o.cb();
} catch (e) {
  console.log("caught", e instanceof RangeError, e.message);
}

console.log("optional", o.missing?.(1), typeof o.cb);
try {
  o.label();
} catch (e) {
  console.log("not callable", e instanceof TypeError);
}

const items = [make(1), make(2), make(3)];
for (const it of items) it.cb = (k) => it.n + k;
console.log("loop", items.map((it) => it.cb(10)).join(","));
