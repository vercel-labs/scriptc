// The forms a generic generator member takes: in a generic class, static (sync and async),
// private, inherited by a subclass, with an inferred result, with explicit type arguments,
// instantiated more than once, never called, and through an interface.
class Box<U> {
  held: U;
  constructor(held: U) {
    this.held = held;
  }
  *pair<T>(other: T): Generator<U | T> {
    yield this.held;
    yield other;
  }
  static *count<T>(xs: T[]): Generator<[number, T]> {
    let i = 0;
    for (const x of xs) yield [i++, x];
  }
  static async *later<T>(x: T): AsyncGenerator<T> {
    await Promise.resolve();
    yield x;
  }
}
class Hidden {
  n = 3;
  *#inner<T>(x: T): Generator<T> {
    for (let i = 0; i < this.n; i++) yield x;
  }
  run<T>(x: T): T[] {
    return [...this.#inner(x)];
  }
}
class Base {
  tag = "base";
  *tags<T>(x: T): Generator<string> {
    yield `${this.tag}:${String(x)}`;
  }
  // No declared result: the generator type is inferred.
  *echo<T>(x: T) {
    yield x;
    yield x;
  }
  // Never called: a generic generator method costs its class nothing.
  async *idle<T>(x: T): AsyncGenerator<T> {
    yield x;
  }
}
class Derived extends Base {
  tag = "derived";
  extra(): string {
    return [...this.tags(1), ...this.tags("s")].join(",");
  }
}
console.log([...new Box(1).pair("a")].join(","), [...new Box("z").pair(true)].join(","));
console.log([...Box.count(["a", "b"])].map(([i, x]) => `${i}${x}`).join(","));
for await (const v of Box.later<number>(7)) console.log(v);
console.log(new Hidden().run("h").join(""), new Hidden().run(2).join(""));
console.log(new Derived().extra(), [...new Base().tags(true)].join(","));
console.log([...new Base().echo("e")].join(""), [...new Derived().echo(3)].length);
const explicit = new Base().tags<number>(5);
console.log(explicit.next().value, explicit.next().done);
// Through an interface: a sync generic generator method by name, and an async one on a receiver
// whose class the build knows.
interface Each {
  each<T>(make: (i: number) => T): Generator<T>;
}
interface Later {
  later<T>(v: T): AsyncGenerator<T>;
}
class Loom implements Each, Later {
  k = 2;
  *each<T>(make: (i: number) => T): Generator<T> {
    for (let i = 0; i < this.k; i++) yield make(i);
  }
  async *later<T>(v: T): AsyncGenerator<T> {
    for (let i = 0; i < this.k; i++) yield v;
  }
}
const loom = new Loom();
console.log([...loom.each((i) => `d${i}`)].join(","));
const each: Each = loom;
console.log([...each.each((i) => i * 2)].join(","));
const later: Later = new Loom();
const laterOut: string[] = [];
for await (const v of later.later("a")) laterOut.push(v);
console.log(laterOut.join(","));
