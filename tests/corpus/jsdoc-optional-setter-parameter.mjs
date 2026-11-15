// A setter's JSDoc may document its JavaScript parameter as optional
// (`[next]`), which TypeScript reports as TS1051 even though the executable
// parameter is mandatory. Node never reads the comment: the setter takes one
// argument, its function has length 1, and the descriptor's setter is that
// function. The corpus pins all of that against Node, for a class and an
// object literal.
class Store {
  constructor() {
    this.stored = null;
    this.writes = 0;
  }
  /** @param {string | null} [next] */
  set value(next) {
    this.writes++;
    this.stored = next;
  }
  get value() {
    return this.stored;
  }
}
const store = new Store();
store.value = "kept";
console.log(store.stored, store.value, store.writes);
store.value = null;
console.log(store.stored, store.value, store.writes);
// Assigning through a dynamic receiver reaches the same setter.
const dynamic = { handle: new Store() };
dynamic.handle.value = "through object";
console.log(dynamic.handle.stored, dynamic.handle.writes);
// An object-literal setter takes the same comment-only optionality.
const events = [];
const record = {
  _value: -1,
  /** @param {number | undefined} [next] */
  set total(next) {
    events.push(next);
    this._value = next === undefined ? -1 : next;
  },
  get total() {
    return this._value;
  },
};
record.total = 7;
console.log(record.total, events.join(","));
record.total = undefined;
console.log(record.total, events.join(","));
const recordDescriptor = Object.getOwnPropertyDescriptor(record, "total");
console.log(typeof recordDescriptor.set, recordDescriptor.set.length);
// The setter body's side effects and evaluation order are unchanged.
const order = [];
function rhs() {
  order.push("rhs");
  return 3;
}
record.total = rhs();
console.log(order.join(","), record.total);
