// A function-local class expression that creates its second Map only when the
// caller asks for it, and reads the iterator of whichever Map holds the
// entries. Reading `.values()` off that field makes the whole-program
// web-stream scan map the class's instance type, which collects the class's
// shape: the Map created below the constructor's top level is one of its
// fields, and a package with this shape (rollup's watcher creates its queue
// under `if (opts.atomic)`) used to stop the compiler with an internal error
// before it wrote any diagnostic.
function makeQueue(atomic) {
  const Queue = class Queue {
    constructor(atomic) {
      this.name = "queue";
      this.settledKeys = new Map();
      if (atomic) this.pendingKeys = new Map();
    }
    add(key, value) {
      if (this.pendingKeys) {
        this.pendingKeys.set(key, value);
      } else {
        this.settledKeys.set(key, value);
      }
    }
    firstValue() {
      const iterator = this.pendingKeys
        ? this.pendingKeys.values()
        : this.settledKeys.values();
      const step = iterator.next();
      return step.done ? "none" : step.value;
    }
    size() {
      return this.pendingKeys ? this.pendingKeys.size : this.settledKeys.size;
    }
  };
  return new Queue(atomic);
}

const atomic = makeQueue(true);
atomic.add("a", 1);
atomic.add("b", 2);
console.log(atomic.name, atomic.size(), atomic.firstValue());

const direct = makeQueue(false);
direct.add("c", 3);
console.log(direct.name, direct.size(), direct.firstValue());
