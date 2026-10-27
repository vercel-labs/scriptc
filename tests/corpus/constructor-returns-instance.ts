// A constructor's returned object replaces the constructed instance when it
// is an object; primitive, bare and `this` returns answer the instance.
class Registry {
  static current: Registry | undefined = undefined;
  readonly id: number = 0;
  entries: string[] = [];
  constructor(id: number) {
    if (Registry.current) return Registry.current;
    this.id = id;
    Registry.current = this;
  }
  add(entry: string): this {
    this.entries.push(entry);
    return this;
  }
}
const first = new Registry(1).add("a");
const second = new Registry(2).add("b");
console.log(first === second, second.id, second.entries.join(","));

// An instance returned only on some paths.
class Slot {
  static previous: Slot | undefined = undefined;
  label: string;
  constructor(label: string, reuse: boolean) {
    this.label = label;
    const previous = Slot.previous;
    Slot.previous = this;
    if (reuse && previous) return previous;
  }
}
const s1 = new Slot("one", true);
const s2 = new Slot("two", true);
const s3 = new Slot("three", false);
console.log(s1.label, s2.label, s3.label, s2 === s1, s3 === s2);

// Constructing the class again inside its own constructor.
class Node2 {
  static made = 0;
  value: number;
  child: Node2 | null = null;
  constructor(depth: number, share: Node2 | null) {
    Node2.made++;
    this.value = depth;
    if (share !== null) return share;
    if (depth > 0) this.child = new Node2(depth - 1, null);
  }
}
const root = new Node2(2, null);
const alias = new Node2(9, root);
console.log(alias === root, alias.value, root.child?.value, root.child?.child?.value, Node2.made);

// A constructor that throws leaves later constructions unaffected.
class Guarded {
  static kept: Guarded | undefined = undefined;
  n: number;
  constructor(n: number) {
    if (n < 0) throw new RangeError(`negative: ${n}`);
    this.n = n;
    if (n === 0 && Guarded.kept) return Guarded.kept;
    Guarded.kept = this;
  }
}
try {
  new Guarded(-1);
} catch (e) {
  console.log((e as Error).message);
}
const g1 = new Guarded(5);
const g2 = new Guarded(0);
const g3 = new Guarded(7);
console.log(g1.n, g2.n, g3.n, g1 === g2, g3 === g1);

// Primitive, bare and `this` returns keep the constructed instance.
class Plain {
  v = 3;
  constructor(mode: number) {
    if (mode === 1) return;
    if (mode === 2) return this;
  }
}
const plain = new Plain(2);
console.log(new Plain(0).v, new Plain(1).v, plain.v, plain instanceof Plain);

// The derived class's own constructor may return an instance of itself.
class Animal {
  sound = "...";
}
class Dog extends Animal {
  static pack: Dog[] = [];
  name: string;
  constructor(name: string) {
    super();
    this.name = name;
    this.sound = "woof";
    const known = Dog.pack.find((d) => d.name === name);
    if (known) return known;
    Dog.pack.push(this);
  }
}
const rex = new Dog("rex");
const again = new Dog("rex");
const fido = new Dog("fido");
console.log(rex === again, fido === rex, Dog.pack.length, again.sound, again instanceof Animal);

// Constructions through class values take the returned instance too.
const Ctor: typeof Registry = Registry;
console.log(new Ctor(3) === first);
function build<T>(make: new (id: number) => T, id: number): T {
  return new make(id);
}
console.log(build(Registry, 4) === first, build(Registry, 5).entries.length);
