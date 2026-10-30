// [util.inspect.custom] methods the runtime inspect walk calls: a class
// method returning an object (Effect's `return this.toJSON()`) that no
// typed code inspects, and a method an Effect-style class inherits from a
// constructor function's prototype object.
const NodeInspectSymbol = Symbol.for("nodejs.util.inspect.custom");

class Exit {
  constructor(value) {
    this.value = value;
  }
  toJSON() {
    return { _id: "Exit", value: this.value };
  }
  [NodeInspectSymbol]() {
    return this.toJSON();
  }
}
const exits = [new Exit(1), new Exit("two")];
console.log(JSON.stringify(exits));
console.log(exits);

const CommitPrototype = {
  toJSON() {
    return { _id: "Commit" };
  },
  [NodeInspectSymbol]() {
    return this.toJSON();
  },
};
const Base = (function () {
  function Base() {}
  Base.prototype = CommitPrototype;
  return Base;
})();
class Effectable extends Base {}
class RefImpl extends Effectable {
  constructor(ref) {
    super();
    this.ref = ref;
  }
}
const ref = new RefImpl(3);
console.log(ref.ref);
console.log(ref, [ref]);
