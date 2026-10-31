// TypeScript listeners that declare a `this` parameter receive the emitter,
// as in Node; arrows and functions without one keep their own `this`.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const ee = new EventEmitter();
ee.on("a", function (this: EventEmitter, x: number) {
  console.log("a", x, this === ee, this.listenerCount("a"));
});
ee.emit("a", 1);

// An overloaded function listener: the implementation reads `this`.
function onLabel(this: EventEmitter, value: string): void;
function onLabel(this: EventEmitter, value: number): void;
function onLabel(this: EventEmitter, value: string | number): void {
  console.log("overloaded", value, this === ee, this.listenerCount("label"));
}
ee.on("label", onLabel);
const labelOf = (n: number): string | number => (n > 0 ? n : "x");
ee.emit("label", labelOf(0));
ee.emit("label", labelOf(2));

class Counter extends EventEmitter {
  n = 0;
}
const c = new Counter();
function onTick(this: Counter, by: number): void {
  this.n += by;
  console.log("tick", by, this.n, this === c);
}
c.on("tick", onTick);
c.emit("tick", 2);
c.once("tick", function (this: Counter) {
  console.log("once", this.n, this instanceof Counter);
});
c.emit("tick", 1);
c.prependListener("tick", function (this: EventEmitter, by: number) {
  console.log("prepend", by, this === c);
});
c.emit("tick", 3);
c.on("arrow", () => console.log("arrow", c.n));
c.emit("arrow");
c.on("nested", function (this: Counter, depth: number) {
  if (depth > 0) this.emit("nested", depth - 1);
  console.log("nested", depth, this.n);
});
c.emit("nested", 2);
console.log(c.listenerCount("tick"));

const p = new PassThrough();
p.on("data", function (this: PassThrough, chunk: Buffer) {
  console.log("data", String(chunk), this === p);
});
p.on("finish", function (this: PassThrough) {
  console.log("finish", this === p);
});
p.write("hi");
p.end();
