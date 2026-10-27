// A function-local class expression extending EventEmitter whose
// instances escape untyped: the class body emits with fixed tuples while
// callers listen, emit and inspect through untyped references.
"use strict";
const { EventEmitter } = require("node:events");

function makeQueue(label) {
  const Queue = class extends EventEmitter {
    constructor() {
      super();
      this.items = [];
    }
    push(item) {
      this.items.push(item);
      this.emit("added", item, this.items.length);
      return this;
    }
    drain() {
      const items = this.items.splice(0);
      this.emit("drained", items.length);
      return items;
    }
    fail(message) {
      this.emit("error", new Error(`${label}: ${message}`));
    }
  };
  return new Queue();
}

const q = makeQueue("q1");
q.on("added", (item, size) => console.log("added", item, size));
q.once("added", (item) => console.log("first add", item));
q.prependListener("drained", (count) => console.log("drained", count));
q.push("a").push("b");
q.emit("added", "manual", 99, "extra");
console.log(q.drain());
q.on("error", (err) => console.log("error", err.message));
q.fail("broken");
console.log(q.listenerCount("added"), q.eventNames(), q.getMaxListeners());
q.removeAllListeners("added");
q.push("c");
console.log(q.listenerCount("added"), q.listeners("drained").length);
q.removeAllListeners();
console.log(q.eventNames());

const q2 = makeQueue("q2");
try {
  q2.fail("nobody listens");
} catch (err) {
  console.log("caught", err.message);
}
const counts = [];
const q3 = makeQueue("q3");
const count = () => counts.push(q3.listenerCount("added"));
q3.on("added", count);
q3.on("added", function self() {
  q3.off("added", self);
  counts.push("self");
});
q3.push(1).push(2);
console.log(counts);
