// A call through an untyped receiver reads its callee before it evaluates
// the arguments: an argument that replaces the member does not change which
// function the call runs. Class instance fields, properties added to an
// instance later, plain object properties, prototype methods, getters, own
// accessors, a field that does not hold a function, and array methods named
// like a class field or getter.
const log = [];
class Holder {
  constructor() {
    this.run = () => "field-init";
  }
  get viaGetter() {
    log.push("getter");
    return () => "from-getter";
  }
}
function callRun(target, replace) {
  return target.run(replace());
}
function callMethod(target, replace) {
  return target.method(replace());
}
function callGetter(target, replace) {
  return target.viaGetter(replace());
}
const holder = new Holder();
holder.run = () => "field-old";
console.log(
  callRun(holder, () => {
    holder.run = () => "field-new";
    return 0;
  }),
  holder.run(),
);
function callExtra(target, replace) {
  return target.extra(replace());
}
const later = new Holder();
later.extra = () => "added-old";
console.log(
  callExtra(later, () => {
    later.extra = () => "added-new";
    return 0;
  }),
  later.extra(),
);
const plain = { run: () => "plain-old" };
console.log(
  callRun(plain, () => {
    plain.run = () => "plain-new";
    return 0;
  }),
  plain.run(),
);
class Swapped {
  method() {
    return "method-old";
  }
}
console.log(
  callMethod(new Swapped(), () => {
    Swapped.prototype.method = () => "method-new";
    return 0;
  }),
  new Swapped().method(),
);
console.log(
  callGetter(new Holder(), () => {
    log.push("argument");
    return 0;
  }),
  log.join(","),
);
log.length = 0;
const accessorTarget = { run: () => "plain" };
Object.defineProperty(accessorTarget, "run", {
  get() {
    log.push("own-getter");
    return () => "own-accessor";
  },
  configurable: true,
});
console.log(
  callRun(accessorTarget, () => {
    log.push("argument");
    return 0;
  }),
  log.join(","),
);
class Box {
  constructor(value) {
    this.run = value;
  }
}
try {
  callRun(new Box(5), () => 0);
} catch (e) {
  console.log(e instanceof TypeError, e.message);
}
// Fields and getters named like builtin methods: calls of those methods on
// arrays and numbers through untyped receivers keep the builtin, and the
// getters still answer for class instances.
class Material {
  constructor() {
    this.map = null;
  }
  get filter() {
    return () => "material-filter";
  }
  get toFixed() {
    return (digits) => `material-${digits}`;
  }
}
function doubled(items) {
  return items.map((x) => x * 2).filter((x) => x > 2);
}
function fixed(value, digits) {
  return value.toFixed(digits);
}
function filtered(value) {
  return value.filter(() => true);
}
console.log(new Material().map, doubled([1, 2, 3]).join(","), filtered([4, 5]).join(","));
console.log(fixed(3.14159, 2), fixed(new Material(), 3), filtered(new Material()));
// A second class with the same getter, constructed only in a method that
// an untyped call reaches: its instances also read the getter before the
// arguments.
const order = [];
class EarlyRunner {
  get step() {
    order.push("early-get");
    return (value) => `early-${value}`;
  }
}
class LateRunner {
  get step() {
    order.push("late-get");
    return (value) => `late-${value}`;
  }
}
class RunnerFactory {
  make() {
    return new LateRunner();
  }
}
function noted(value) {
  order.push(`arg-${value}`);
  return value;
}
function step(target, value) {
  return target.step(noted(value));
}
function made(factory) {
  return factory.make();
}
console.log(step(new EarlyRunner(), 1), step(made(new RunnerFactory()), 2), order.join(","));
