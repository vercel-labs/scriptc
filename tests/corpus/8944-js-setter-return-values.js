// A set accessor may contain a `return` (TS2408); [[Set]] discards the value
// the setter returns, so an assignment expression's value is always the
// right-hand side Node assigned, never the setter's return.
class Box {
  constructor() {
    this.v = 0;
  }
  set value(x) {
    this.v = x;
    return x * 2;
  }
  get value() {
    return this.v;
  }
}
const box = new Box();
const assigned = (box.value = 21);
console.log(box.v, assigned);

// An early `return` in a setter ends the set but still discards nothing the
// assignment observes.
const early = {
  stored: -1,
  set item(next) {
    if (next === undefined) {
      return "ignored";
    }
    this.stored = next;
  },
};
console.log(early.item = undefined, early.stored);
console.log((early.item = 3), early.stored);

// The assignment still yields its right-hand side inside a larger expression.
const record = {
  v: 0,
  set value(next) {
    this.v = next;
    return null;
  },
};
const total = (record.value = 4) + 1;
console.log(total, record.v);
