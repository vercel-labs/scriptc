// @requires-libnode
// A program class instance inside a Node island is seen as a class instance
// is in Node: its fields are its own properties, and what the class declares
// is on its prototype, with methods non-enumerable and accessors as
// accessors. So a write through a setter runs the setter, a write to a
// getter-only accessor throws in strict code, and reflection (`in`,
// Object.hasOwn, descriptors, keys, JSON.stringify with a toJSON) answers
// as Node does. A frozen record refuses island writes the way Node's does.
import { call, get, members, reflect, remove, sameProto, set, sloppy } from "class-pkg";

class Counter {
  n: number;
  constructor(n: number) {
    this.n = n;
  }
  inc(): number {
    this.n += 1;
    return this.n;
  }
  get double(): number {
    return this.n * 2;
  }
  set double(x: number) {
    this.n = x / 2;
  }
  get label(): string {
    return "n" + this.n;
  }
}
const counter = new Counter(3);
console.log(members(counter, ["n", "inc", "double", "label", "nope"]));
console.log(reflect(counter));
console.log("setter:", set(counter, "double", 80), counter.n, counter.double, get(counter, "double"));
console.log("getter only:", set(counter, "label", "x"), sloppy.set(counter, "label", "x"), counter.label);
console.log("field:", set(counter, "n", 9), counter.n, get(counter, "label"), call(counter, "inc"), counter.n);

// Inherited members, overrides and super calls.
class Base {
  id = 1;
  hello(): string {
    return "base" + this.id;
  }
  get kind(): string {
    return "base";
  }
  get level(): number {
    return this.id;
  }
  set level(x: number) {
    this.id = x;
  }
  shared(): string {
    return "shared" + this.id;
  }
}
class Derived extends Base {
  extra = "e";
  override hello(): string {
    return "derived" + this.id + super.hello();
  }
  override get kind(): string {
    return "derived";
  }
  only(): string {
    return this.extra;
  }
}
const derived = new Derived();
const base = new Base();
console.log(members(derived, ["id", "extra", "hello", "kind", "only"]));
console.log(reflect(derived));
console.log("calls:", call(derived, "hello"), call(derived, "only"), call(derived, "shared"), call(base, "hello"), call(base, "only"));
console.log("accessors:", get(derived, "kind"), get(base, "kind"), set(derived, "level", 7), derived.id, derived.level, get(derived, "level"));
console.log("prototypes:", sameProto(derived, new Derived()), sameProto(derived, base), sameProto(base, counter));

// Private and static members are not properties of an instance.
class Vault {
  static count = 0;
  static make(): Vault {
    return new Vault();
  }
  #secret = 42;
  open = true;
  reveal(): number {
    return this.#secret;
  }
  get size(): number {
    return this.#secret;
  }
  #hidden(): number {
    return 1;
  }
  via(): number {
    return this.#hidden();
  }
}
const vault = Vault.make();
console.log(members(vault, ["open", "reveal", "size", "via", "count", "make", "#secret", "secret"]));
console.log(reflect(vault));
console.log("private:", call(vault, "reveal"), call(vault, "via"), get(vault, "size"), get(vault, "#secret"));

// toString and toJSON declared by the class are the ones island code finds;
// an own property the island writes hides a method.
class Box {
  v = 1;
  get(): number {
    return this.v;
  }
  put(x: number): void {
    this.v = x;
  }
  toString(): string {
    return "Box(" + this.v + ")";
  }
  toJSON(): unknown {
    return { boxed: this.v };
  }
}
const box = new Box();
console.log(reflect(box));
console.log("methods:", call(box, "get"), call(box, "put", 5), box.v, get(box, "v"));
console.log("own over method:", set(box, "extra", 1), get(box, "extra"), set(box, "get", 3), get(box, "get"), remove(box, "nope"));

// A frozen record takes no island write: a TypeError in strict code,
// nothing in sloppy code, and the value stays.
const frozen = Object.freeze({ a: 1 });
console.log("frozen:", set(frozen, "a", 2), sloppy.set(frozen, "a", 3), remove(frozen, "a"), sloppy.remove(frozen, "a"), set(frozen, "b", 1), get(frozen, "b"), frozen.a);
const plain = { a: 1 };
console.log("plain:", set(plain, "a", 2), plain.a, remove(plain, "nope"));
