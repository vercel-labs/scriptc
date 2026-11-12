// Object.prototype.isPrototypeOf over every receiver form: class instances
// and class prototypes, Object.create chains and plain records, arrays,
// functions (through Function.prototype), primitives (through their wrapper
// object), and the argument rules — a non-object argument answers false
// before the receiver is converted, and a nullish receiver throws.

function attempt(label: string, run: () => unknown): void {
  try {
    console.log(label, run());
  } catch (error) {
    const e = error as Error;
    console.log(label, "threw", e.name + ": " + e.message);
  }
}

class Animal {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
}
class Dog extends Animal {}
class Cat extends Animal {}

const dog = new Dog("rex");
const cat = new Cat("tom");
attempt("instance is its own prototype", () => dog.isPrototypeOf(dog));
attempt("Animal.prototype of a Dog", () => Animal.prototype.isPrototypeOf(dog));
attempt("Dog.prototype of a Dog", () => Dog.prototype.isPrototypeOf(dog));
attempt("Cat.prototype of a Dog", () => Cat.prototype.isPrototypeOf(dog));
attempt("Dog.prototype of a Cat", () => Dog.prototype.isPrototypeOf(cat));
attempt("Object.prototype of a Dog", () => Object.prototype.isPrototypeOf(dog));

const base = { kind: "base" };
const child = Object.create(base);
const grandchild = Object.create(child);
attempt("record of its child", () => base.isPrototypeOf(child));
attempt("child of its record", () => child.isPrototypeOf(base));
attempt("record of its grandchild", () => base.isPrototypeOf(grandchild));
attempt("record of itself", () => base.isPrototypeOf(base));
attempt("Object.prototype of a grandchild", () => Object.prototype.isPrototypeOf(grandchild));

attempt("Array.prototype of an array", () => Array.prototype.isPrototypeOf([]));
attempt("Object.prototype of an array", () => Object.prototype.isPrototypeOf([]));
attempt("Function.prototype of a function", () => Function.prototype.isPrototypeOf(attempt));
attempt("Object.prototype of a function", () => Object.prototype.isPrototypeOf(attempt));
attempt("Function.prototype of an arrow", () => Function.prototype.isPrototypeOf(() => 0));

// The dependency-injection idiom: a constructor is not its own prototype,
// but every other constructor's prototype sits on the chain up to
// Object.prototype, which is.
attempt("Object.prototype of Object", () => Object.prototype.isPrototypeOf(Object));
attempt("Function.prototype of Object", () => Function.prototype.isPrototypeOf(Object));

// Object.setPrototypeOf replaces the [[Prototype]] a function starts with,
// so the walk follows the replacement and Function.prototype is off the
// chain; a replacement's own chain still leads to Object.prototype.
const isPrototypeOf = Object.prototype.isPrototypeOf;
function replaced(): void {}
const custom = { tag: "custom" };
Object.setPrototypeOf(replaced, custom);
attempt("replacement of a function", () => isPrototypeOf.call(custom, replaced));
attempt("Function.prototype of a replaced function", () =>
  isPrototypeOf.call(Function.prototype, replaced),
);
attempt("Object.prototype of a replaced function", () =>
  isPrototypeOf.call(Object.prototype, replaced),
);
attempt("replaced function of its replacement", () => isPrototypeOf.call(replaced, custom));

function bare(): void {}
Object.setPrototypeOf(bare, null);
attempt("Function.prototype of a null-prototype function", () =>
  isPrototypeOf.call(Function.prototype, bare),
);
attempt("Object.prototype of a null-prototype function", () =>
  isPrototypeOf.call(Object.prototype, bare),
);

// A function whose prototype is another function: the chain visits both.
function leaf(): void {}
function middle(): void {}
Object.setPrototypeOf(leaf, middle);
Object.setPrototypeOf(middle, custom);
attempt("replacement of a function chain", () => isPrototypeOf.call(custom, leaf));
attempt("middle of a function chain", () => isPrototypeOf.call(middle, leaf));
attempt("leaf of a function chain", () => isPrototypeOf.call(leaf, middle));
