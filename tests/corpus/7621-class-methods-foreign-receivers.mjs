// Prototype methods called with a receiver that is not an instance of
// their class (`C.prototype.m.call(other)`): `#private` members throw
// Node's TypeErrors for such a receiver, and `super.m()` looks the method up
// on the base class's prototype and calls it with the receiver.
function report(label, run) {
  try {
    console.log(label, run());
  } catch (error) {
    console.log(label, error.constructor.name, error.message);
  }
}

class Counter {
  #count = 0;
  #step = 1;
  constructor(name) {
    this.name = name;
  }
  read() {
    return this.#count;
  }
  bump() {
    this.#count += this.#step;
    return this.#count;
  }
  reset(value) {
    this.#count = value;
    return this.name;
  }
  #label() {
    return `${this.name}#${this.#count}`;
  }
  label() {
    return this.#label();
  }
  owns(value) {
    return #count in value;
  }
  ownsSelf() {
    return #count in this;
  }
}

const counter = new Counter("c");
console.log(counter.bump(), counter.bump(), counter.read(), counter.label());
console.log(counter.owns(counter), counter.owns({}), counter.ownsSelf(), counter.reset(7), counter.read());

const plain = { name: "plain" };
report("read", () => Counter.prototype.read.call(plain));
report("bump", () => Counter.prototype.bump.call(plain));
report("reset", () => Counter.prototype.reset.call(plain, 3));
report("label", () => Counter.prototype.label.call(plain));
report("ownsSelf", () => Counter.prototype.ownsSelf.call(plain));
report("owns primitive", () => Counter.prototype.owns.call(counter, 5));
report("label undefined", () => Counter.prototype.label.call(undefined));
report("label null", () => Counter.prototype.label.call(null));
report("label number", () => Counter.prototype.label.call(4));
report("read other instance", () => Counter.prototype.read.call(new Counter("d")));
report("label other instance", () => Counter.prototype.label.call(new Counter("e")));

const Anonymous = class {
  #m() {
    return 1;
  }
  call() {
    return this.#m();
  }
};
const Named = class Inner {
  #m() {
    return 2;
  }
  call() {
    return this.#m();
  }
};
report("anonymous", () => Anonymous.prototype.call.call({}));
report("named", () => Named.prototype.call.call({}));
console.log(new Anonymous().call(), new Named().call());

class Shape {
  constructor(name) {
    this.name = name;
  }
  describe() {
    return `shape ${this.name}`;
  }
  area() {
    return 0;
  }
}
class Square extends Shape {
  describe() {
    return `square: ${super.describe()} area ${this.area()}`;
  }
  area() {
    return this.size * this.size;
  }
  both() {
    return [super.describe(), super.area()].join("|");
  }
}
class Tiny extends Square {
  #tag = "t";
  describe() {
    return `tiny<${super.describe()}>`;
  }
  tag() {
    return `${this.#tag}:${super.both()}`;
  }
}

const square = new Square("s");
square.size = 3;
console.log(square.describe(), square.both());
const tiny = new Tiny("t");
tiny.size = 1;
console.log(tiny.describe(), tiny.tag());
const foreign = {
  name: "f",
  size: 2,
  area() {
    return 40;
  },
};
report("square describe", () => Square.prototype.describe.call(foreign));
report("square both", () => Square.prototype.both.call(foreign));
report("tiny describe", () => Tiny.prototype.describe.call(foreign));
report("tiny tag", () => Tiny.prototype.tag.call(foreign));
report("square describe on tiny", () => Square.prototype.describe.call(tiny));

// A base method that builds `new this.constructor()` on a subclass instance
// builds the subclass, also once the base prototype is complete (a super call
// above reads it) and `copy` is read through its prototype slot.
class Node3 {
  constructor() {
    this.a = 0;
  }
  copy(source) {
    this.a = source.a;
    return this;
  }
  clone() {
    return new this.constructor().copy(this);
  }
}
class Mesh3 extends Node3 {
  constructor(geometry) {
    super();
    this.geometry = geometry;
  }
  copy(source) {
    super.copy(source);
    this.geometry = source.geometry;
    return this;
  }
}
const copyValue = Node3.prototype.copy;
const mesh = new Mesh3({ id: 1 });
mesh.a = 5;
const meshClone = mesh.clone();
console.log(
  meshClone instanceof Mesh3,
  meshClone.constructor === Mesh3,
  mesh.constructor === Mesh3,
  meshClone.a,
  JSON.stringify(meshClone.geometry),
  typeof copyValue,
);

// Methods that use a private accessor or return a private method keep their own receiver, as values too.
class Vault {
  #v = 1;
  get #value() {
    return this.#v * 10;
  }
  set #value(x) {
    this.#v = x;
  }
  #hidden() {
    return "hidden " + this.#v;
  }
  read() {
    return this.#value;
  }
  bump() {
    this.#value = this.#v + 1;
    return this.#v;
  }
  hiddenValue() {
    return this.#hidden;
  }
}
const vault = new Vault();
const readVault = Vault.prototype.read;
const bumpVault = Vault.prototype.bump;
const hiddenOf = Vault.prototype.hiddenValue;
console.log(readVault.call(vault), bumpVault.call(vault), readVault.call(vault), typeof hiddenOf.call(vault));
console.log(hiddenOf.call(vault).call(vault));
try {
  readVault.call({});
} catch (error) {
  console.log(error.constructor.name);
}

// A method value whose body calls super with spread arguments.
class Summer {
  add(...xs) {
    return xs.reduce((sum, x) => sum + x, 0);
  }
}
class Doubler extends Summer {
  add(...xs) {
    return super.add(...xs) * 2;
  }
}
const addValue = Doubler.prototype.add;
console.log(addValue.call(new Doubler(), 1, 2, 3), addValue.apply(new Doubler(), [4, 5]));
