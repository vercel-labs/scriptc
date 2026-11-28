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

// Repeated reads keep answering: the answer is a test of the live stream,
// not a cache of recently built views.
let reads = 0;
for (let i = 0; i < 20; i++) if (typeof plain[Symbol.asyncIterator] === "function") reads += 1;
console.log("reads", reads);

// Streams released before an ordinary class's instances are made: their
// addresses may be reused, and that must never make a class view look like
// a stream.
class Plain {
  constructor() {
    this.value = 1;
  }
}
const instances = [];
for (let i = 0; i < 8; i++) {
  const released = Readable.from(["z"]);
  released.destroy();
  instances.push(new Plain());
}
console.log("instances", instances.map((v) => typeof v[Symbol.asyncIterator]).join(","));

// Streams released through their own reference count leave the live set with
// them: the registry does not accumulate entries for destroyed streams.
let alive = 0;
for (let i = 0; i < 200; i += 1) {
  const released = Readable.from(["s"]);
  if (typeof released[Symbol.asyncIterator] === "function") alive += 1;
  released.destroy();
}
console.log("alive", alive);
