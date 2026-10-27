// A write with a computed string key can replace any method, so calls of
// every method name check the receiver for an own property first. Generic
// class instances, their subclasses and mixin classes keep their declared
// methods when no own property replaces them.
class Ctx<T = string> {
  v: number;
  constructor() {
    this.v = 0;
  }
  json(o: T): string {
    return JSON.stringify(o);
  }
  status(n: number): Ctx<T> {
    this.v = n;
    return this;
  }
}

class Box<T> {
  value: T;
  constructor(value: T) {
    this.value = value;
  }
  get(): T {
    return this.value;
  }
  describe(): string {
    return `box(${String(this.value)})`;
  }
}

class NumberBox extends Box<number> {
  double(): number {
    return this.value * 2;
  }
  describe(): string {
    return `number ${super.describe()}`;
  }
}

class Base {
  name(): string {
    return "base";
  }
}

class Tagged<T> extends Base {
  tag: T;
  constructor(tag: T) {
    super();
    this.tag = tag;
  }
  label(): string {
    return `${this.name()}:${String(this.tag)}`;
  }
}

type Ctor<T = {}> = new (...args: any[]) => T;
function Sized<B extends Ctor>(Base: B) {
  return class extends Base {
    size(): number {
      return 3;
    }
  };
}
const SizedBase = Sized(Base);

function write(target: object, key: string, value: unknown): void {
  (target as any)[key] = value;
}

const c = new Ctx<{ ok: boolean }>();
write(c, "other", () => 42);
console.log(typeof c.json, typeof c.status, c.status(200).json({ ok: true }), c.v);

const a = new Box<string>("a");
const b = new Box<number>(1);
const n = new NumberBox(4);
const t = new Tagged<boolean>(true);
const s = new SizedBase();
console.log(a.get(), a.describe(), b.get(), b.describe());
console.log(n.get(), n.double(), n.describe(), t.label(), t.name(), s.size(), s.name());
console.log(Object.prototype.hasOwnProperty.call(a, "get"));
const read = a.get;
console.log(read.call(a));

write(b, "describe", () => "replaced");
write(n, "double", () => -1);
write(s, "size", () => 0);
console.log(b.describe(), a.describe(), Object.prototype.hasOwnProperty.call(b, "describe"));
console.log(n.double(), new NumberBox(3).double(), s.size(), new SizedBase().size());
const boxes: Box<number>[] = [b, n, new Box<number>(7)];
console.log(boxes.map((box) => box.describe()).join(" | "));
