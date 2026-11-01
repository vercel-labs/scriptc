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
