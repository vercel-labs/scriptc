// A generic factory returns its own local class through a declared
// constructor type, and a class extends the factory's result. The local
// class's static methods read the factory's parameter, inherit into the
// subclass, and call each other through `this`.
type Struct<S> = (abstract new () => S) & { readonly decode: (value: unknown) => S };
function struct<S>(value: S): Struct<S> {
  abstract class Base {
    static decode(_input: unknown): S {
      return value;
    }
  }
  return Base as Struct<S>;
}
class Counter extends struct({ value: 42 }) {}
console.log(Counter.decode(null).value);

type Named<T> = (new (label: string) => { label: string; payload: T }) & {
  readonly describe: () => string;
  readonly make: (label: string) => { label: string; payload: T };
};
function named<T>(kind: string, payload: T): Named<T> {
  class Entry {
    label: string;
    payload: T;
    constructor(label: string) {
      this.label = label;
      this.payload = payload;
    }
    static describe(): string {
      return `entry of ${kind}`;
    }
    static make(label: string): Entry {
      return new this(label);
    }
  }
  return Entry;
}
class Tag extends named("tag", [1, 2, 3]) {
  shout(): string {
    return this.label.toUpperCase();
  }
}
const tag = new Tag("hello");
console.log(tag.shout(), tag.payload.join("+"), Tag.describe());
const made = Tag.make("made");
console.log(made.label, made.payload.length);

const Flags = named("flag", { on: true });
const flag = new Flags("first");
console.log(flag.label, flag.payload.on, Flags.describe());
const Other = named("other", 5);
console.log(Other.describe(), new Other("x").payload, Flags.describe());

// A function-local class's static methods read the function's parameter and
// call each other through `this`.
function twice(n: number): number {
  class K {
    static double(): number {
      return n * 2;
    }
    static quad(): number {
      return this.double() * 2;
    }
  }
  return K.double() + K.quad();
}
console.log(twice(3), twice(5));

// The factory returns an anonymous class expression, directly or through a
// `const` binding.
function anonymous<S>(value: S): Struct<S> {
  return class {
    static decode(_input: unknown): S {
      return value;
    }
  } as unknown as Struct<S>;
}
class Anonymous extends anonymous({ tag: "anon" }) {}
console.log(Anonymous.decode(null).tag);

type Holder<T> = (new (held: T) => { held: T }) & { readonly seed: () => T };
function holder<T>(initial: T): Holder<T> {
  const Hold = class {
    held: T;
    constructor(held: T) {
      this.held = held;
    }
    static seed(): T {
      return initial;
    }
  };
  return Hold;
}
class Boxed extends holder(7) {
  twice(): number {
    return this.held * 2;
  }
}
console.log(new Boxed(4).twice(), Boxed.seed());
