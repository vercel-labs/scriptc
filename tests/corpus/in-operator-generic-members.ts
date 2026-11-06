// Generic members live in the class's own generic-method table rather than
// its plain method table, and they are still present on every instance.
class Generic {
  pick<T>(value: T): T {
    return value;
  }
  make = <T>(value: T): T => value;
  plain(): string {
    return "p";
  }
}
const generic = new Generic();
console.log(
  "generic:",
  "pick" in generic,
  "make" in generic,
  "plain" in generic,
  "nope" in generic,
);

// A field initialized with a generic function is collected like a method (no
// closure slot can hold a generic function), but Node defines its property
// when that field's own initializer runs: an initializer before it does not
// see it, one after it does, and a generic method is on the prototype
// throughout.
class GenericFieldOrder {
  before = "run" in this;
  run = <T>(value: T): T => value;
  after = "run" in this;
  beforeMethod = "pick" in this;
  pick<T>(value: T): T {
    return value;
  }
}
const ordered = new GenericFieldOrder();
console.log(
  "generic field order:",
  ordered.before,
  ordered.after,
  ordered.beforeMethod,
  ordered.run(3),
);

// The same question through a base-typed receiver answers for the declaring
// subclass.
class GenericBase {}
class GenericDerived extends GenericBase {
  choose<T>(value: T): T {
    return value;
  }
}
const derived: GenericBase = new GenericDerived();
console.log("subclass:", "choose" in derived, "nope" in derived);
