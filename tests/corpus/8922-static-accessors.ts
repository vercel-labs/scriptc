// Static accessors of a TypeScript class: a read calls the getter and an
// assignment calls the setter, with the class the member is read through
// as `this`, as in Node. An inherited accessor runs with the subclass as its
// receiver, and `super.x` in a static accessor reads the base class's.

class Env {
  static get mode(): string {
    return "prod";
  }
}
console.log("simple", Env.mode);

// A private static behind a getter, and the lazy singleton.
class Counter {
  static #count = 0;
  static get count(): number {
    return Counter.#count;
  }
  static bump(): void {
    Counter.#count++;
  }
}
Counter.bump();
Counter.bump();
class Config {
  static #instance: Config | undefined = undefined;
  value = 1;
  static get instance(): Config {
    return (Config.#instance ??= new Config());
  }
}
console.log("backed", Counter.count, Config.instance.value, Config.instance === Config.instance);

// A getter and setter pair, and a setter with no getter.
class Settings {
  private static stored = 1;
  static get level(): number {
    return Settings.stored;
  }
  static set level(value: number) {
    Settings.stored = value * 2;
  }
}
Settings.level = 4;
class Sink {
  static last = "";
  static set value(text: string) {
    Sink.last = `got:${text}`;
  }
}
Sink.value = "x";
console.log("set", Settings.level, Sink.last);

// `this` in a static getter is the class the property is read through.
class Named {
  static prefix = "<";
  static get tag(): string {
    return `${this.prefix}${this.name}>`;
  }
}
class Sub extends Named {
  static prefix = "[";
}
console.log("this", Named.tag, Sub.tag);

// Inherited, overridden, and `super` in a static accessor and method.
class A {
  static get kind(): string {
    return "a";
  }
  static get depth(): number {
    return 1;
  }
  static get who(): string {
    return this.name;
  }
  static describe(): string {
    return `describe:${this.name}`;
  }
}
class B extends A {
  static get kind(): string {
    return `${super.kind}>b`;
  }
  static get depth(): number {
    return super.depth + 1;
  }
  static get who(): string {
    return `${super.who}!`;
  }
  static describe(): string {
    return `${super.describe()}+b`;
  }
}
class C extends B {
  static get kind(): string {
    return `${super.kind}>c`;
  }
}
console.log("chain", A.kind, B.kind, C.kind, A.depth, B.depth, C.depth);
console.log("receiver", A.who, B.who, C.who, B.describe(), C.describe());

// Read inside a method, read twice in one expression, and a getter that
// throws.
class Limits {
  static get limit(): number {
    return 3;
  }
  over(n: number): boolean {
    return n > Limits.limit;
  }
}
let log = "";
class Sequence {
  static n = 0;
  static get next(): number {
    log += "g";
    return ++Sequence.n;
  }
}
const sum = Sequence.next + Sequence.next * 2;
class Lazy {
  static get boom(): number {
    throw new RangeError("not ready");
  }
}
let thrown = "";
try {
  console.log(Lazy.boom);
} catch (error) {
  thrown = (error as Error).message;
}
console.log("order", new Limits().over(4), new Limits().over(2), sum, log, Sequence.n, thrown);

// A lazy shared instance through `this`.
class Registry {
  private static shared: Registry | undefined = undefined;
  items: string[] = [];
  static get global(): Registry {
    return (this.shared ??= new this());
  }
}
Registry.global.items.push("x");
console.log("lazy", Registry.global.items.length, Registry.global === Registry.global);
