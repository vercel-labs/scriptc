// A class expression's prototype read as a value: the binding has no
// call-site class type, so its stored class value stands for the class. The
// view answers the same own properties the class declares — constructor,
// methods and accessors, in declaration order, with the specification's
// descriptors — and holds the identity its instances inherit from.
var Anonymous = class {
  constructor(n) {
    this.n = n;
  }
  get label() {
    return "anon:" + this.n;
  }
  set label(v) {
    this.n = Number(v);
  }
  m() {
    return this.n + 1;
  }
  #secret = 11;
  #priv() {
    return this.#secret;
  }
  peek() {
    return this.#priv();
  }
};
var Named = class Inner {
  m() {
    return "inner";
  }
  static make() {
    return new Named();
  }
};
const Bound = class extends Anonymous {
  m() {
    return super.m() * 2;
  }
};
const first = new Anonymous(4);
const second = Named.make();
console.log(first.m(), first.label, first.peek());
console.log(second.m(), new Bound(2).m(), new Bound(2).label);
console.log(typeof Anonymous.prototype, typeof Bound.prototype);
console.log(Anonymous.prototype === Anonymous.prototype, Bound.prototype === Bound.prototype);
console.log(Anonymous.prototype.constructor === Anonymous, Named.prototype.constructor === Named);
console.log(Bound.prototype.constructor === Bound, Named.name, Anonymous.name);
console.log(Object.getPrototypeOf(Bound.prototype) === Anonymous.prototype);
console.log(Object.getPrototypeOf(Anonymous.prototype) === Object.prototype);
console.log(first instanceof Anonymous, first instanceof Bound, first instanceof Named);
// The Test262 idiom: the prototype answers for its declared members and for
// nothing else; instances carry fields, not members.
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
console.log(
  own(Anonymous.prototype, "m"),
  own(Anonymous.prototype, "#secret"),
  own(Anonymous.prototype, "#priv"),
  own(first, "#secret"),
  own(Anonymous.prototype, "constructor"),
  own(Anonymous.prototype, "nope"),
);
console.log(Object.getOwnPropertyNames(Anonymous.prototype).join(","));
console.log(Object.getOwnPropertyNames(Named.prototype).join(","));
console.log(Object.getOwnPropertyNames(Bound.prototype).join(","));
const method = Object.getOwnPropertyDescriptor(Anonymous.prototype, "m");
console.log(method.writable, method.enumerable, method.configurable, typeof method.value);
const accessor = Object.getOwnPropertyDescriptor(Anonymous.prototype, "label");
console.log("value" in accessor, typeof accessor.get, typeof accessor.set);
console.log(accessor.enumerable, accessor.configurable);
console.log(Object.keys(Anonymous.prototype).length);
const inherited = [];
for (const key in Anonymous.prototype) inherited.push(key);
console.log(inherited.length);
// The value handed to a plain function keeps its identity and its shape.
function describe(prototype) {
  return Object.getOwnPropertyNames(prototype).length + ":" + prototype.constructor.name;
}
console.log(describe(Anonymous.prototype), describe(Named.prototype), describe(Bound.prototype));
// A foreign receiver inherits the reflected methods.
const foreign = Object.create(Anonymous.prototype);
foreign.n = 5;
console.log(foreign.m(), foreign.label, foreign instanceof Anonymous);
// A class expression bound in an inner block still answers.
{
  const Scoped = class {
    hi() {
      return "scoped";
    }
  };
  console.log(Scoped.prototype.hi(), own(Scoped.prototype, "hi"), Scoped.prototype.constructor === Scoped);
}
console.log(Anonymous.prototype.m === first.m, Anonymous.prototype.m === Bound.prototype.m);
