// EventEmitter.prototype's methods through Function.prototype.call when the
// holder is a stored class field or a record entry: the read has no effects,
// so the method keeps its typed lowering on the receiver.
import { EventEmitter } from "node:events";

const log: (string | number | boolean)[][] = [];
const ee = new EventEmitter();
const other = new EventEmitter();

ee.on("a", function (this: unknown, x: number) {
  log.push(["a", x, this === ee]);
});

class Box {
  emitter: EventEmitter;
  constructor(emitter: EventEmitter) {
    this.emitter = emitter;
  }
  fire(target: EventEmitter, value: number): boolean {
    return this.emitter.emit.call(target, "a", value);
  }
}

const box = new Box(other);
console.log(box.emitter.emit.call(ee, "a", 1));
console.log(box.fire(ee, 2));

const record = { emitter: other };
console.log(record.emitter.emit.call(ee, "a", 3));

const held: Readonly<{ emitter: EventEmitter }> = { emitter: other };
console.log(
  held.emitter.listenerCount.call(ee, "a"),
  held.emitter.listenerCount.call(other, "a"),
);
held.emitter.on.call(ee, "b", function (this: unknown, v: number) {
  log.push(["b", v, this === ee]);
});
console.log(ee.listenerCount("b"));
console.log(ee.emit("b", 4));

console.log(JSON.stringify(log));
