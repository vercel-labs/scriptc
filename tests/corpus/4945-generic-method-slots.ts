// Generic classes keep their methods when the program also holds a write
// that could replace a method by any name. Such a write makes every method
// replaceable, and a replaceable method is read from the instance's property
// bag, with the class's prototype data behind it. Generic classes, their
// instantiations and their subclasses have no prototype data, so the reads
// found nothing and the calls failed with "is not a function". They check
// the bag for an own entry now and fall back to the declared method: calls
// inside a getter, from outside, through a receiver typed with the
// non-generic base, method values and typeof all find it, and a method the
// program does replace on one instance is replaced on that instance only.

class Dep {
  hits: number;
  constructor() {
    this.hits = 0;
  }
  track(): void {
    this.hits++;
  }
  label(): string {
    return "dep";
  }
}

class Box<T> extends Dep {
  held: T;
  constructor(held: T) {
    super();
    this.held = held;
  }
  get value(): T {
    this.track();
    return this.held;
  }
  read(): T {
    this.track();
    return this.held;
  }
  override label(): string {
    return "box";
  }
}

class NumberBox extends Box<number> {
  double(): number {
    return this.read() * 2;
  }
}

const put = (target: object, key: string, value: unknown): void => {
  (target as Record<string, unknown>)[key] = value;
};
const name = process.argv.length > 99 ? "other" : "label";

const n = new Box(4);
console.log("getter:", n.value, n.hits);
console.log("method:", n.read(), n.hits);
const s = new Box("text");
console.log("string box:", s.value.toUpperCase(), s.read().length, s.hits);
console.log("typeof:", typeof n.read, typeof n.label);
const read = n.read;
console.log("method value:", read.call(n), n.hits);
const asBase: Dep = n;
asBase.track();
console.log("through the base:", asBase.label(), n.hits);
const sub = new NumberBox(5);
console.log("subclass of an instantiation:", sub.double(), sub.label(), sub.hits);

const replaced = new Box(true);
put(replaced, name, () => "replaced");
console.log("replaced:", replaced.label(), (replaced as Dep).label(), typeof replaced.label);
console.log("own key:", Object.keys(replaced).includes("label"));
console.log("others keep theirs:", n.label(), new Box(0).label(), sub.label());

const plain = new Dep();
plain.track();
console.log("plain:", plain.label(), plain.hits);
put(plain, name, () => "plain replaced");
console.log("plain replaced:", plain.label(), new Dep().label());
