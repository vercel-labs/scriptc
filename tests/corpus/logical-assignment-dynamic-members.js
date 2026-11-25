// Logical assignment (`??=`, `||=`, `&&=`) in an untyped program, where the
// member a key names is not declared anywhere: object literals, class
// instances (a computed key on `this`), a member map, and a function's own
// properties. The read and the write both go through the same checked
// dynamic view a plain `o[key] = v` uses, so the stored value is visible to
// later member reads and to `Object.keys`.

let calls = 0;
function make() {
  calls += 1;
  return 3;
}

class Store {
  constructor() {
    this.cache = {};
    this.count = 0;
  }

  getOr(key, fallback) {
    return (this[key] ||= fallback);
  }

  add(key) {
    this[key] ??= 0;
    this[key] = this[key] + 1;
    return this[key];
  }

  keep(key, value) {
    this[key] &&= value;
    return this[key];
  }
}

const store = new Store();
console.log("getOr", store.getOr("first", 7), store.getOr("first", 9));
console.log("add", store.add("hits"), store.add("hits"), store.hits);
console.log("keep", store.keep("first", 4), store.keep("missing", 5), store.missing);
console.log("keys", Object.keys(store).join(","));

const bag = {};
bag.zero ??= make();
bag.nul ??= null;
console.log("bag", bag.zero, bag.nul, calls);
bag.empty ||= "filled";
bag.falsy = 0;
bag.falsy ||= 2;
console.log("or", bag.empty, bag.falsy);

const key = "dynamic";
bag[key] ??= make();
bag[key] &&= "changed";
console.log("keyed", bag.dynamic, calls);

// The right side is evaluated only when the test says so, and the
// expression yields the member's value afterwards.
const kept = (bag.dynamic ||= make());
const made = (bag.fresh ||= make());
console.log("results", kept, made, calls);

// Receiver and key evaluate once per assignment.
let lookups = 0;
function holder() {
  lookups += 1;
  return store.cache;
}
function slot() {
  lookups += 1;
  return "slot";
}
console.log("once", (holder()[slot()] ??= 8), lookups, store.cache.slot);

// A function's own property, as a bundle assigns one.
function handler() {
  return "handled";
}
handler.calls ??= 0;
handler.calls = handler.calls + 1;
handler.ready ||= true;
console.log("fn", handler.calls, handler.ready, handler());
