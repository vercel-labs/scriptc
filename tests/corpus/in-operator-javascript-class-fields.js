// A JavaScript class creates its own fields by assignment, so `in` asks the
// instance: a constructor branch that did not run leaves its field absent,
// and a method can add one later.
class Conditional {
  constructor(flag) {
    if (flag) this.value = 1;
  }
}
console.log(
  "conditional:",
  "value" in new Conditional(false),
  "value" in new Conditional(true),
  "missing" in new Conditional(true),
);

class Lazy {
  touch() {
    this.count = 1;
  }
}
const lazy = new Lazy();
console.log("lazy:", "count" in lazy);
lazy.touch();
console.log("lazy:", "count" in lazy);

// Names the class never declares: a property added at runtime is present,
// and the prototype's names always are.
class Plain {}
const plain = new Plain();
plain.extra = 7;
console.log("added:", "extra" in plain, "missing" in plain, "toString" in plain);

// A union of class types answers per arm, and an arm whose fields are
// created by assignment still asks the instance.
const pick = (usePlain, flag) => (usePlain ? new Plain() : new Conditional(flag));
console.log(
  "union:",
  "value" in pick(true, true),
  "value" in pick(false, true),
  "value" in pick(false, false),
);
