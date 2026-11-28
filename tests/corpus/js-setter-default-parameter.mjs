// A JavaScript setter may declare a default parameter. TypeScript's grammar
// forbids it (TS1052), but Node runs the setter and applies the default when
// the assigned value is undefined.
class Counter {
  constructor() {
    this.stored = 0;
  }
  set value(next = this.stored + 1) {
    this.stored = next;
  }
}

const counter = new Counter();
counter.value = undefined;
console.log(counter.stored);
counter.value = 7;
console.log(counter.stored);

const box = {
  seen: [],
  set entry(next = "empty") {
    this.seen.push(next);
  },
};

box.entry = undefined;
box.entry = null;
box.entry = "filled";
console.log(box.seen.join("|"));
