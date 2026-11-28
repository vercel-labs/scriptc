// A stream's [Symbol.asyncIterator]: Node's method on a plain readable (even
// when the value is held as a checked-dynamic one), the class's own override
// when a subclass declares one, and undefined on a writable-only stream.
import { Readable, Writable } from "node:stream";

const plain = /** @type {any} */ (Readable.from(["a", "b"]));
console.log("plain", typeof plain[Symbol.asyncIterator]);
const first = await plain[Symbol.asyncIterator]().next();
console.log("first", String(first.value), first.done);

class Guarded extends Readable {
  _read() {
    this.push("x");
    this.push(null);
  }
  async *[Symbol.asyncIterator]() {
    console.log("guard");
    yield "custom";
  }
}
const guarded = /** @type {any} */ (new Guarded());
const overridden = await guarded[Symbol.asyncIterator]().next();
console.log("guarded", String(overridden.value), overridden.done);

const writable = /** @type {any} */ (
  new Writable({
    write(chunk, encoding, callback) {
      callback();
    },
  })
);
console.log("writable", String(writable[Symbol.asyncIterator]));
