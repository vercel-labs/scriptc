// @requires-libnode
// A class instance crosses into an island with its prototype methods
// however it gets there. Here the first instance to cross is typed as the
// class, and the second is held in a binding typed by the island's
// interface. This order always worked;
// 8779-node-island-class-crossing-typed-first is the same program with the
// two crossings in the other order, which used to throw "sink.take is not
// a function" inside the island. Both must print the same answers.
import { shape, useSink, type Sink } from "sink-pkg";

class Counter implements Sink {
  name = "counter";
  sum = 0;
  take(n: number): number {
    this.sum += n;
    return this.sum;
  }
}

// 1. Typed as the class: the class's first crossing.
const direct = new Counter();
console.log("direct", shape(direct), useSink(direct));

// 2. Typed by the island's interface.
const typed: Sink = new Counter();
console.log("typed", shape(typed), useSink(typed));

// 3. Both again, and the native side sees what the island did.
console.log(useSink(typed), useSink(direct), typed.take(1), direct.sum);
