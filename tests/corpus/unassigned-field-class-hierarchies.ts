// Fields read before their assignment across two and three levels of
// classes: the read can sit in an override two levels below the
// constructor that makes the call, behind `super.method()`, in an
// accessor, or in a callback the constructor passes to a function that
// calls it at once.

class A {
  constructor() {
    this.hook();
  }
  hook(): void {}
}
class B extends A {
  name!: string;
  count!: number;
  hook(): void {
    console.log("B.hook", typeof this.name, typeof this.count, this.name ?? "noname", this.count === undefined);
  }
}
class C extends B {
  deep: string = "deep";
  hook(): void {
    super.hook();
    console.log("C.hook", typeof this.deep, this.deep ?? "nodeep");
  }
}
const c = new C();
c.name = "n";
c.count = 2;
c.hook();

// The middle class's field is read by the override of the class below it.
class Root {
  constructor() {
    console.log("root sees", this.summary());
  }
  summary(): string {
    return "root";
  }
}
class Middle extends Root {
  level = 2;
  names: string[] = ["m"];
}
class Leaf extends Middle {
  leaf = true;
  summary(): string {
    return [
      this.level === undefined ? "no level" : "level " + this.level,
      this.names === undefined ? "no names" : "names " + this.names.length,
      this.leaf === undefined ? "no leaf" : "leaf",
    ].join(", ");
  }
}
const leaf = new Leaf();
console.log(leaf.summary());
console.log(new Middle().level, new Middle().names.length);

// An accessor, and a callback that captures the instance.
class Model {
  constructor() {
    console.log("model", this.display);
    [1].forEach(() => this.touch());
  }
  get display(): string {
    return "model";
  }
  touch(): void {}
}
class Titled extends Model {
  title = "T";
  touched = 0;
  get display(): string {
    return this.title === undefined ? "untitled" : this.title;
  }
  touch(): void {
    this.touched = (this.touched ?? 100) + 1;
    console.log("touched", this.touched);
  }
}
const titled = new Titled();
console.log(titled.display, titled.touched);
titled.touch();

// The method is run through `call`, `apply`, a bound copy or as a callback
// the constructor hands to a function.
class Wired {
  constructor() {
    console.log(this.first.call(this), this.second.apply(this, []));
    const third = this.third.bind(this);
    console.log(third(), [0].map(this.fourth, this).join());
  }
  first(): string {
    return "first";
  }
  second(): string {
    return "second";
  }
  third(): string {
    return "third";
  }
  fourth(): string {
    return "fourth";
  }
}
class WiredFields extends Wired {
  a = "a";
  b = 2;
  c: string[] = ["c"];
  d = true;
  first(): string {
    return this.a ?? "no a";
  }
  second(): string {
    return this.b === undefined ? "no b" : String(this.b);
  }
  third(): string {
    return this.c === undefined ? "no c" : this.c.join();
  }
  fourth(): string {
    return typeof this.d;
  }
}
const wired = new WiredFields();
console.log(wired.first(), wired.second(), wired.third(), wired.fourth());

// A class's own constructor calls its own method before assigning.
class Settings {
  retries: number;
  hosts: Set<string>;
  constructor() {
    console.log(this.report());
    this.retries = 3;
    this.hosts = new Set(["a"]);
    console.log(this.report());
  }
  report(): string {
    return (this.retries ?? "no retries") + " " + (this.hosts === undefined ? "no hosts" : this.hosts.size);
  }
}
new Settings();

// Fields that construction never reads early keep reading as declared.
class Plain {
  constructor() {
    this.setup();
  }
  setup(): void {}
}
class Counter extends Plain {
  value = 7;
  step = 2;
  setup(): void {
    console.log("setup runs before the fields exist");
  }
  bump(): number {
    this.value += this.step;
    return this.value;
  }
}
const counter = new Counter();
console.log(counter.bump(), counter.bump());

// Generic classes: every instance of the class reads the same way.
class Store<T> {
  constructor(seed: T) {
    console.log("store sees", this.describe(seed));
  }
  describe(seed: T): string {
    return "store:" + String(seed);
  }
}
class Cached<T> extends Store<T> {
  hits = 5;
  label = "L";
  describe(seed: T): string {
    return [typeof this.hits, this.hits === undefined, typeof this.label, this.label ?? "nolabel", String(seed)].join(":");
  }
}
console.log(new Cached<number>(1).describe(2));
console.log(new Cached<string>("a").describe("b"));
