// Every evaluation of a class definition creates a new class: a distinct
// constructor, a distinct prototype object, and its own statics. Node
// evaluates `class { … }` and `class C { … }` each time control reaches
// them, so a loop body and a repeatedly called function both produce a new
// class per evaluation.
const values = [];
const prototypes = [];
for (let i = 0; i < 2; i++) {
  const Anonymous = class {};
  values.push(Anonymous);
  prototypes.push(Anonymous.prototype);
}
console.log("expression identity:", values[0] === values[1]);
console.log("expression prototype:", prototypes[0] === prototypes[1]);

const declared = [];
for (let i = 0; i < 2; i++) {
  class Declared {}
  declared.push(Declared);
}
console.log("declaration identity:", declared[0] === declared[1]);

// Statics belong to the evaluation that created them: mutating the first
// iteration's static leaves the second iteration's at its initial value.
const counters = [];
for (let i = 0; i < 2; i++) {
  class Counter {
    static made = 0;
    static make() {
      return ++Counter.made;
    }
    tag = i;
  }
  counters.push(Counter);
}
console.log("statics:", counters[0].make(), counters[0].make(), counters[1].make(), counters[0].made, counters[1].made);

// An instance carries the class of the evaluation that constructed it, so
// `instanceof` answers only for that evaluation.
const instances = [];
const classes = [];
for (let i = 0; i < 2; i++) {
  class Item {
    constructor() {
      this.tag = i;
    }
  }
  classes.push(Item);
  instances.push(new Item());
}
console.log("instances:", instances[0].tag, instances[1].tag);
console.log("instanceof:", instances[0] instanceof classes[0], instances[0] instanceof classes[1], instances[1] instanceof classes[1]);

// A closure made inside the class body captures the iteration it was
// evaluated in.
const readers = [];
for (let i = 0; i < 3; i++) {
  class Reader {
    read() {
      return i;
    }
  }
  readers.push(() => new Reader().read());
}
console.log("capture:", readers.map((read) => read()).join(","));

// An instance field initializer runs per construction, so a class
// expression there is evaluated once per instance.
class Outer {
  inner = class {};
}
const first = new Outer();
const second = new Outer();
console.log("field initializer:", first.inner === second.inner);

// A function called repeatedly mints a class per call.
function makeClass() {
  class Local {
    static count = 0;
    static bump() {
      return ++Local.count;
    }
  }
  return Local;
}
console.log("function local:", makeClass() === makeClass(), makeClass().bump(), makeClass().bump());
