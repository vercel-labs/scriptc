// @requires-libnode
// Native closures passed into a Node island run as V8 functions: event
// listeners, synchronous callbacks, Node-style async callbacks, and
// exceptions crossing both ways.
import { Bus, compute, each, guarded, same, twice } from "emitter-pkg";

const bus = new Bus();
let total = 0;
const listener = (n: number, label: string): void => {
  total += n;
  console.log("listener", n, label);
};
bus.on("data", listener);
bus.once("data", (n: number) => console.log("once", n));
console.log("delivered", bus.fire(3));
console.log("delivered", bus.fire(4));
console.log("count", bus.listenerCount("data"), "total", total);
bus.off("data", listener);
console.log("delivered", bus.fire(5));

console.log(each(3, (x: number, i: number) => x * 10 + i));
console.log(twice((n: number) => `n=${n}`));

// A native throw propagates through island frames, where JS can catch it.
console.log(guarded((v: number) => {
  if (v > 1) throw new RangeError(`too big: ${v}`);
  return v;
}, 2));
console.log(guarded((v: number) => v + 1, 1));

// An exception thrown natively and not caught by the island reaches the caller.
bus.on("boom", () => {
  throw new TypeError("native boom");
});
try {
  bus.emit("boom");
} catch (e) {
  console.log("caught", e instanceof TypeError, (e as Error).message);
}

// The same closure crosses as the same function.
const f = (n: number): string => `${n}`;
console.log("same", same(f, f));

compute(6, (err: Error | null, value?: number) => {
  console.log("compute", err, value);
  compute(-1, (err2: Error | null, value2?: number) => {
    console.log("compute", err2 instanceof RangeError, err2?.message, value2);
  });
});
console.log("end of main");
