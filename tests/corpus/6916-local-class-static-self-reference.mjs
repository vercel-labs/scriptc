// Static fields, static blocks and static methods of function-local classes
// that read the class by its name while the class is being defined.
function registry(prefix) {
  class Registry {
    static label = Registry.name + ":" + prefix;
    static instances = [];
    static {
      Registry.ready = Registry.instances.length === 0;
    }
    constructor(id) {
      this.id = id;
      Registry.instances.push(this);
    }
    static create(id) {
      return new Registry(id);
    }
  }
  return Registry;
}
const R = registry("main");
R.create(1);
R.create(2);
console.log(R.label, R.ready, R.instances.map((r) => r.id));
const R2 = registry("other");
console.log(R2.label, R2.instances.length, R2 === R, R.instances.length);

function counter(step) {
  class Counter {
    static zero = new Counter(0);
    static one = Counter.zero.next();
    constructor(value) {
      this.value = value;
    }
    next() {
      return new Counter(this.value + step);
    }
  }
  return Counter;
}
const C = counter(5);
console.log(C.zero.value, C.one.value, C.one.next().value, C.one instanceof C);

function described() {
  class Shape {
    static kinds = ["circle", "square"];
    static describe() {
      return Shape.kinds.map((kind) => kind + "@" + Shape.name).join(",");
    }
  }
  return Shape.describe();
}
console.log(described());
