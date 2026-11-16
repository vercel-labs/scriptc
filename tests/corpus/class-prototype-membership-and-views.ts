// A class's prototype as a value: `name in C.prototype` answers for the
// methods and accessors the class and its bases declare, Object.prototype's
// members and members the program adds or deletes, and the prototype object
// itself is the one Object.create, Object.getPrototypeOf and isPrototypeOf
// see, as in Node.

class Base {
  field = 4;
  base(): number {
    return 1;
  }
  static make(): Base {
    return new Base();
  }
  get size(): number {
    return 2;
  }
  #hidden(): number {
    return 3;
  }
  reveal(): number {
    return this.#hidden();
  }
}
class Derived extends Base {
  name = "d";
  own(): string {
    return "own " + this.name;
  }
  set label(value: string) {
    this.name = value;
  }
}

const names = [
  "base",
  "make",
  "size",
  "#hidden",
  "field",
  "own",
  "label",
  "constructor",
  "toString",
  "hasOwnProperty",
  "__proto__",
  "missing",
];
console.log(names.map((n) => `${n}:${n in Derived.prototype}/${n in Base.prototype}`).join(" "));
const key: string = ["own", "nope"][0]!;
console.log(key in Derived.prototype, key in Base.prototype);

(Base.prototype as any).extra = 6;
console.log("extra" in Base.prototype, "extra" in Derived.prototype);
delete (Base.prototype as any).extra;
console.log("extra" in Base.prototype);

const proto: any = Object.create(Derived.prototype);
const d = new Derived();
const b = new Base();
console.log(typeof proto.own, proto.own === d.own, Derived.prototype.own.call(d));
console.log(
  Object.getPrototypeOf(d) === Derived.prototype,
  Object.getPrototypeOf(Derived.prototype) === Base.prototype,
  Object.getPrototypeOf(proto) === Derived.prototype,
);
console.log(
  Derived.prototype.isPrototypeOf(d),
  Base.prototype.isPrototypeOf(d),
  Derived.prototype.isPrototypeOf(b),
  Base.prototype.isPrototypeOf(proto),
  proto.isPrototypeOf(d),
);
console.log(d.reveal(), d.size, Base.make().base());
