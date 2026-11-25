// Chained assignment in an untyped program. The lazy-init idiom writes
// `void 0` into a group of fields in one chained statement — in the
// constructor, where the checker infers the field's type from the LATER
// write, and again in a reset method. Node stores exactly what each
// assignment writes, so the field's slot keeps the undefined arm: reads
// answer undefined before the first real write, and the chain's own value
// is the right side's value.

class Kernel {
  constructor() {
    this["~dispatch"] = this["~composed"] = void 0;
    this["~dispatch"] = (event) => `handled ${event}`;
    this["~composed"] = (event) => `composed ${event}`;
    this.count = 0;
  }

  reset() {
    this["~dispatch"] = this["~composed"] = void 0;
  }

  ready() {
    return this["~dispatch"] !== undefined;
  }
}

const app = new Kernel();
console.log("built", typeof app["~dispatch"], app["~composed"]("x"), app.ready());
app.reset();
console.log("reset", app["~dispatch"], app["~composed"], app.ready());

// The named spelling, where the constructor declares the fields with the
// unit write and the checker types them from the function written next.
class Loader {
  constructor() {
    this.ready = this.result = void 0;
    this.ready = true;
    this.result = "done";
  }

  reset() {
    this.ready = this.result = void 0;
    return this.ready;
  }
}

const loader = new Loader();
console.log("loader", loader.ready, loader.result);
console.log("loader reset", loader.reset(), loader.ready, loader.result);

// A statically-resolvable key held in a binding, and the chain's value in
// a declaration initializer.
class Slot {
  constructor() {
    const key = "~slot";
    this[key] = void 0;
    this[key] = 3;
  }

  clear() {
    const key = "~slot";
    this[key] = void 0;
  }
}

const slot = new Slot();
console.log("slot", slot["~slot"], typeof slot["~slot"]);
slot.clear();
console.log("slot clear", slot["~slot"], slot["~slot"] === undefined);

// Plain checked-dynamic objects: the chain stores through the same keyed
// write a single assignment uses, once per link.
const bag = {};
const picked = (bag.x = bag.y = 6);
bag.nested = bag.other = undefined;
console.log("bag", picked, bag.x, bag.y, bag.nested, bag.other, Object.keys(bag).join(","));

// The right side evaluates once even when the chain has several links, and
// the receiver of each link is evaluated in order.
let runs = 0;
function next() {
  runs += 1;
  return runs;
}
let tail = undefined;
const chained = (tail = bag.count = next());
console.log("once", chained, tail, bag.count, runs);
