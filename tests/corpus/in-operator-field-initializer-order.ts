// Node defines a field as its own initializer finishes, so a membership test
// inside an initializer sees the fields defined before it, and the fields the
// base class already defined, but not the ones this class defines later.
class Base {
  inherited = 1;
}
class Derived extends Base {
  before = "inherited" in this;
  later = "own" in this;
  own = 2;
  after = "own" in this;
  absent = "nothing" in this;
  method = "describe" in this;
  describe(): string {
    return "d";
  }
}
const derived = new Derived();
console.log(
  "initializers:",
  derived.before,
  derived.later,
  derived.after,
  derived.absent,
  derived.method,
);

// A function body inside the initializer runs later, once every field exists.
class Deferred {
  check = (): boolean => "value" in this;
  value = 3;
}
const deferred = new Deferred();
console.log("deferred:", deferred.check(), "value" in deferred);
