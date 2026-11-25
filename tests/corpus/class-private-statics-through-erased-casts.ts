// A private static read through a cast that erases its receiver's type
// (`(ctor as any).#x`) resolves the private name in the enclosing class
// body: it reads the declaring class's own storage after the brand check,
// never a public property of the same spelling on the class object.

class Vault {
  static #trusted = "sealed";
  static label = "vault";
  read(ctor: typeof Vault): string {
    return (ctor as any).#trusted;
  }
  readUnknown(ctor: unknown): string {
    return (ctor as any).#trusted;
  }
  static readOwn(): string {
    return (Vault as any).#trusted;
  }
}

// A public property spelled like the private name is an ordinary key.
Reflect.set(Vault, "#trusted", "public");
const vault = new Vault();
console.log((Vault as any).label, Reflect.get(Vault, "#trusted"));
console.log(vault.read(Vault));
console.log(vault.readUnknown(Vault));
console.log(Vault.readOwn());
for (const other of [{ "#trusted": "public" }, class {}, 1, undefined, null]) {
  try {
    console.log(vault.readUnknown(other));
  } catch (e) {
    console.log((e as Error).name, (e as Error).message);
  }
}

// Writes, updates and calls through a checked-dynamic receiver take the
// same brand check and reach the same storage.
class Counter {
  static #count = 0;
  static #name = "counter";
  static #tag(): string {
    return "tag";
  }
  rename(ctor: unknown, value: string): void {
    (ctor as any).#name = value;
  }
  bump(ctor: unknown): number {
    return ++(ctor as any).#count;
  }
  tag(ctor: unknown): string {
    return (ctor as any).#tag();
  }
  static state(): string {
    return `${Counter.#name}:${Counter.#count}`;
  }
}

const counter = new Counter();
counter.rename(Counter, "renamed");
console.log(counter.bump(Counter), counter.bump(Counter), Counter.state());
console.log(counter.tag(Counter));
for (const other of [{}, class {}, undefined, null]) {
  const uses: (() => unknown)[] = [
    () => counter.rename(other, "x"),
    () => counter.bump(other),
    () => counter.tag(other),
  ];
  for (const use of uses) {
    try {
      use();
      console.log("no throw");
    } catch (e) {
      console.log((e as Error).name, (e as Error).message);
    }
  }
}
console.log(Counter.state());
