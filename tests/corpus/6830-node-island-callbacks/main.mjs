// @requires-libnode
// Native closures passed into a Node island run as V8 functions: event
// listeners, synchronous callbacks, Node-style async callbacks, and
// exceptions crossing both ways.
import { requireModule } from "@scriptc/node";

const { Bus, compute, each, guarded, same, twice } = requireModule("./lib.cjs");

const bus = new Bus();
let total = 0;
const listener = (n, label) => {
  total += n;
  console.log("listener", n, label);
};
bus.on("data", listener);
bus.once("data", (n) => console.log("once", n));
console.log("delivered", bus.fire(3));
console.log("delivered", bus.fire(4));
console.log("count", bus.listenerCount("data"), "total", total);
bus.off("data", listener);
console.log("delivered", bus.fire(5));

console.log(each([1, 2, 3], (x, i) => x * 10 + i).join(","));
console.log(twice((n) => `n=${n}`).join(" "));

// A native throw propagates through island frames, where JS can catch it.
console.log(guarded((v) => {
  if (v > 1) throw new RangeError(`too big: ${v}`);
  return v;
}, 2));
console.log(guarded((v) => v + 1, 1));

// An exception thrown natively and not caught by the island reaches the caller.
bus.on("boom", () => {
  throw new TypeError("native boom");
});
try {
  bus.emit("boom");
} catch (e) {
  console.log("caught", e instanceof TypeError, e.message);
}

// The same closure crosses as the same function.
const f = (n) => `${n}`;
console.log("same", same(f, f));

compute(6, (err, value) => {
  console.log("compute", err, value);
  compute(-1, (err2, value2) => {
    console.log("compute", err2 instanceof RangeError, err2 && err2.message, value2);
  });
});
console.log("end of main");
