// An anonymous function that initializes a class field is named after the
// field, as a `const` binding names its initializer. The name is read here
// through values that cannot know it statically.
interface Io {
  read: (x: number) => number;
  write: (x: number) => number;
}
type Fn = (x: number) => number;

class Proc implements Io {
  read = (x: number): number => x + 1;
  write = function (x: number): number {
    return x - 1;
  };
  wrapped = ((x: number): number => x) as Fn;
  parenthesized = (x: number): number => x;
  static make = (x: number): number => x;
  "quoted-name" = (): number => 1;
  #hidden = (): number => 2;
  hidden(): unknown {
    return this.#hidden;
  }
}

const nameOf = (value: unknown): string =>
  typeof value === "function" ? JSON.stringify(value.name) : "not a function";

const io: Io = new Proc();
const read: unknown = io.read;
const write: unknown = io.write;
console.log(nameOf(read), nameOf(write));

const proc = new Proc();
const fields: unknown[] = [
  proc.wrapped,
  proc.parenthesized,
  Proc.make,
  proc["quoted-name"],
];
console.log(fields.map(nameOf).join(" "));
console.log(nameOf(proc.hidden()));

const held: unknown = { held: new Proc().read };
console.log(held);
const instance: unknown = new Proc();
console.log(instance);
console.log((instance as Proc).read(1), (instance as Proc).write(1));

// An object literal's members keep their names beside them.
const literal: unknown = { arrow: (): number => 1, method(): number { return 2; } };
console.log(literal);
