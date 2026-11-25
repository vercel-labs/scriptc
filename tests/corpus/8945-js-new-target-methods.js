// `new.target` is legal in every function body, and in a method body it is
// always undefined because a method is not constructable: `new` never calls
// one, and a [[Construct]] on a method throws before any body runs. A method
// that reads it therefore observes undefined, in the object literal and the
// class forms alike (TS17013).
const literal = {
  read() {
    return new.target;
  },
  get observed() {
    return new.target;
  },
  set observed(next) {
    console.log("literal set", new.target, next);
  },
};
console.log(literal.read(), literal.observed);
literal.observed = 1;

class Widget {
  constructor() {
    this.v = 1;
  }
  read() {
    return new.target;
  }
  get observed() {
    return new.target;
  }
  set observed(next) {
    console.log("widget set", new.target, next);
  }
  nested() {
    return (() => new.target)();
  }
}
const widget = new Widget();
console.log(widget.read(), widget.observed, widget.nested());
widget.observed = 2;

// A constructor still sees the class that was constructed, so the
// meta-property keeps its construct meaning where `new` is in play.
class Base {
  constructor() {
    this.seen = new.target;
  }
}
class Derived extends Base {}
console.log(new Derived().seen === Derived, new Base().seen === Base);
