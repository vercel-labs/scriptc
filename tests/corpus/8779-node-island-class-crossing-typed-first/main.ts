// @requires-libnode
// A class instance crosses into an island with its prototype methods
// however it gets there. Here the first instance to cross is held in a
// binding typed by the island's interface, so the crossing expression does
// not name the class. The island's `sink.take(2)` used to throw "sink.take
// is not a function" for it, because the class's methods were registered
// only when an expression statically typed as the class crossed, once per
// class: the answer depended on what had crossed before.
// 8780-node-island-class-crossing-direct-first is the same program with
// the two crossings in the other order.
import { shape, useSink, type Sink } from "sink-pkg";

class Counter implements Sink {
  name = "counter";
  sum = 0;
  take(n: number): number {
    this.sum += n;
    return this.sum;
  }
}

// 1. Typed by the island's interface: the class's first crossing.
const typed: Sink = new Counter();
console.log("typed", shape(typed), useSink(typed));

// 2. Typed as the class.
const direct = new Counter();
console.log("direct", shape(direct), useSink(direct));

// 3. Both again, and the native side sees what the island did.
console.log(useSink(typed), useSink(direct), typed.take(1), direct.sum);
