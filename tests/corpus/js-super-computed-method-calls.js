// super[key](...) with run-time keys in untyped JavaScript: the base
// prototype's member the key names, called over the derived method's own
// `this` — key conversion, argument forwarding, members installed after the
// class is declared, symbol keys, own fields that shadow nothing, and Node's
// TypeError when the key names no callable member.

function attempt(label, run) {
  try {
    console.log(label, run());
  } catch (error) {
    console.log(label, "threw", error.name + ": " + error.message);
  }
}

class Base {
  who() {
    return "base";
  }
  add(a, b) {
    return a + b;
  }
  0() {
    return "zero";
  }
}

class Derived extends Base {
  who() {
    return "derived+" + super["who"]();
  }
  call(key, ...args) {
    return super[key](...args);
  }
  indexed() {
    return super[0]();
  }
  boxed() {
    return super[{ toString: () => "who" }]();
  }
}

const d = new Derived();
console.log(d.who());
console.log(d.call("add", 2, 3));
console.log(d.indexed());
attempt("boxed key", () => d.boxed());
attempt("missing string key", () => d.call("nope"));
attempt("missing numeric key", () => d.call(7));

// A prototype member installed after the class is declared, through the
// same key the method dispatches on.
Base.prototype.late = function (x) {
  return "late " + x;
};
attempt("late-installed member", () => d.call("late", 4));

const symbolKey = Symbol("s");
class SymBase {
  [symbolKey]() {
    return "sym";
  }
}
class SymDerived extends SymBase {
  duo() {
    const key = symbolKey;
    return super[key]() + "+";
  }
}
console.log(new SymDerived().duo());
attempt("own field shadows nothing", () => {
  class Shadow extends Base {
    constructor() {
      super();
      this.who = () => "own";
    }
    both() {
      const key = "who";
      return this.who() + "/" + super[key]();
    }
  }
  return new Shadow().both();
});
