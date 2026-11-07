// A class method read as a value takes its receiver from the call. A method
// whose only uses of `this` are tests the type answers for an instance
// (`this === undefined`, `typeof this`, `this instanceof C`, `typeof
// this.tag`) still has a receiver to check: called with an instance it
// answers for that instance, and called without one it throws a TypeError,
// as it does under Node when it goes on to read a member.
class Counter {
  tag = "counter";
  isMissing(): boolean {
    return this === undefined;
  }
  isNullish(): boolean {
    return this == null;
  }
  isPresent(): boolean {
    return this !== undefined;
  }
  kind(): string {
    return typeof this;
  }
  mine(): boolean {
    return this instanceof Counter;
  }
  tagKind(): string {
    return typeof this.tag;
  }
  hasTag(): boolean {
    return this.tag !== undefined;
  }
  defaulted(missing: boolean = this === undefined): boolean {
    return missing;
  }
  guarded(): string {
    if (!this) throw new TypeError("must be called on an instance");
    return this.tag;
  }
  checked(): string {
    if (!(this instanceof Counter)) throw new TypeError("Illegal invocation");
    return this.tag;
  }
  visit(_item?: unknown): void {
    console.log("visit", this === undefined, typeof this, this instanceof Counter);
  }
  // An overloaded method: its implementation is what reads the receiver.
  label(): string;
  label(prefix: string): string;
  label(prefix?: string): string {
    return (prefix ?? "") + typeof this;
  }
  owned(): string;
  owned(prefix: string): string;
  owned(prefix?: string): string {
    if (this === undefined) throw new TypeError("no receiver");
    return (prefix ?? "") + this.tag;
  }
  // No use of `this` at all: callable without a receiver.
  twice(x: number): number {
    return x * 2;
  }
  // `this` only inside a nested function, which binds its own.
  nested(): boolean {
    function inner(this: unknown): boolean {
      return this === undefined;
    }
    return inner.call(1);
  }
}

const c = new Counter();
const other = new Counter();
other.tag = "other";

function thrown(f: () => unknown): string {
  try {
    f();
    return "no error";
  } catch (e) {
    return e instanceof TypeError ? "TypeError" : "another error";
  }
}

// An instance supplied by bind, call, apply and Reflect.apply.
console.log("bind", c.isMissing.bind(c)(), c.isNullish.bind(c)(), c.isPresent.bind(c)());
console.log("bind", c.kind.bind(c)(), c.mine.bind(c)(), c.tagKind.bind(c)(), c.hasTag.bind(c)());
console.log("bind", c.defaulted.bind(c)(), c.guarded.bind(c)(), c.checked.bind(c)());
console.log("call", c.isMissing.call(c), c.isNullish.call(c), c.isPresent.call(c));
console.log("call", c.kind.call(c), c.mine.call(c), c.tagKind.call(c), c.hasTag.call(c));
console.log("call", c.defaulted.call(c), c.guarded.call(other), c.checked.call(other));
console.log("apply", c.isMissing.apply(c, []), c.kind.apply(c, []), c.guarded.apply(other, []));
console.log("reflect", Reflect.apply(c.isMissing, c, []), Reflect.apply(c.mine, other, []));

// A method value held in a binding, then given its receiver.
const isMissing = c.isMissing;
const kind = c.kind;
const guarded = c.guarded;
console.log("held", isMissing.call(c), kind.call(other), guarded.call(other));
const boundKind = kind.bind(c);
console.log("held bound", boundKind(), [boundKind].map((f) => f()).join());

// A callback with its receiver passed beside it.
[1, 2].forEach(c.visit, c);

// Without a receiver, a method that reads or guards its receiver throws a
// TypeError.
const tagKind = c.tagKind;
const hasTag = c.hasTag;
const checked = c.checked;
console.log("unbound", thrown(tagKind), thrown(hasTag), thrown(guarded), thrown(checked));
console.log("unbound", thrown(() => c.tagKind.call(undefined)), thrown(() => guarded.apply(null, [])));

// Overloaded methods are checked like any other.
const label = c.label;
const owned = c.owned;
console.log("overloaded", label.call(c, ">"), c.label.bind(other)(), owned.call(other, ">"));
console.log("overloaded unbound", thrown(owned), thrown(() => owned.call(undefined, ">")));

// Methods that never mention their own `this` run without a receiver.
const twice = c.twice;
const nested = c.nested;
console.log("receiver-free", twice(21), [1, 2, 3].map(c.twice).join(), nested());
console.log("receiver-free", thrown(twice.bind(undefined, 4)), twice.call(undefined, 5));

// Inherited, overridden, generic, function-local, private and async methods.
class Base {
  tag = "base";
  who(): string {
    return this === undefined ? "nobody" : this.tag;
  }
  same(): boolean {
    return this instanceof Base;
  }
}
class Derived extends Base {
  override who(): string {
    return typeof this === "undefined" ? "nobody" : `derived ${this.tag}`;
  }
}
const base = new Base();
const derived: Base = new Derived();
console.log("inherited", derived.same.call(derived), base.same.bind(derived)());
console.log("override", derived.who.bind(derived)(), base.who.call(derived), derived.who.call(derived));

class Box<T> {
  value: T;
  constructor(value: T) {
    this.value = value;
  }
  full(): boolean {
    return this !== undefined && this.value !== undefined;
  }
}
const box = new Box(7);
console.log("generic", box.full.bind(box)(), box.full.call(new Box(8)));

function makeLocal(): () => string {
  class Local {
    tag = "local";
    who(): string {
      return this === undefined ? "nobody" : this.tag;
    }
  }
  const local = new Local();
  return local.who.bind(local);
}
console.log("local", makeLocal()());

class Sealed {
  tag = "sealed";
  #who(): string {
    return this === undefined ? "nobody" : this.tag;
  }
  run(): string {
    const who = this.#who;
    return who.call(this);
  }
}
console.log("private", new Sealed().run());

class Later {
  tag = "later";
  async who(): Promise<string> {
    return this === undefined ? "nobody" : this.tag;
  }
}
const later = new Later();
void later.who
  .call(later)
  .then((value) => console.log("async", value))
  .then(() => Promise.resolve(1).then(c.visit.bind(c)));
