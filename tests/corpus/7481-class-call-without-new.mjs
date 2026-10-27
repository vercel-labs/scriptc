// An ES5 constructor that calls a class constructor as its base, and the
// other ways of calling a class without `new`, throw Node's TypeError.
class Base {
  constructor() {
    this.n = 1;
  }
}

function report(label, run) {
  try {
    run();
    console.log(label, "returned");
  } catch (error) {
    console.log(label, error instanceof TypeError, error.message);
  }
}

function Sub() {
  Base.call(this);
  this.m = 2;
}
report("es5 subclass", () => new Sub());

function Applied() {
  Base.apply(this, arguments);
}
report("es5 apply", () => new Applied(1, 2));

report("apply null", () => Base.apply(null, null));
report("apply non-object", () => Base.apply(null, 5));
report("apply array-like", () => Base.apply({}, { length: 1, 0: "a" }));

const order = [];
function effect(label, value) {
  order.push(label);
  return value;
}
report("ordered", () => Base.call(effect("this", {}), effect("a", 1), effect("b", 2)));
console.log(order.join(","));

function viaValue(C) {
  report("value " + C.name, () => C.call({}));
}
class Derived extends Base {}
viaValue(Base);
viaValue(Derived);

class Configured {}
Configured.defaults = { size: 1 };
function Wrapped() {
  Configured.call(this, Configured.defaults);
}
report("expando statics", () => new Wrapped());

const Anonymous = class {};
report("anonymous", () => Anonymous.call({}));

class WithCall {
  static call(value) {
    return "own " + value;
  }
}
console.log(WithCall.call(4));
