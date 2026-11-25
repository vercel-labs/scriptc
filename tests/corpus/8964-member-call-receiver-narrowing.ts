// A wrapper that forwards its receiver returns a function that reads
// `this`, so that function escapes. A member call then passes its holder
// only where a store under the member's name may hold such a function: the
// wrapper's result, a chain of constants that ends at one, a copy of a
// member that holds one. Members that only ever hold arrows are called as
// they were, and a call of the value by itself passes no receiver.
type F = () => string;
interface Holder {
  name: string;
  f: F;
}
function label(this: unknown): string {
  const self = this as { name?: unknown } | undefined;
  return self === undefined ? "no receiver" : `receiver ${String(self.name)}`;
}
function wrap<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return function (this: unknown, ...args: A): R {
    return fn.apply(this, args);
  };
}

// Members that only ever hold arrows.
const plain = { name: "plain", f: (): string => "arrow", g: (n: number): number => n + 1 };
console.log(plain.f(), plain.g(1));

// The wrapper's result in a member: the call passes the holder, and the
// wrapper forwards it.
const wrapped: Holder = { name: "wrapped", f: wrap(label as F) };
console.log(wrapped.f(), (wrapped.f)(), wrapped["f"]());

// A chain of constants that ends at the function.
const first = label as F;
const second = first;
const third = second;
const chained: Holder = { name: "chained", f: third };
console.log(chained.f());

// A copy of a member carries what the member holds, under its new name.
const copy = { name: "copy", run: wrapped.f, quiet: plain.f };
console.log(copy.run(), copy.quiet());

// A class is the holder of its static field, in every spelling.
class Registry {
  static f: F = wrapped.f;
}
console.log(Registry.f() !== "no receiver", (Registry.f)() !== "no receiver");

// A function is the holder of its own members.
function carrier(): void {}
carrier.f = wrapped.f;
console.log(carrier.f() !== "no receiver");

// The value by itself: no receiver.
const detached = wrapped.f;
console.log(detached(), (0, wrapped.f)());
export {};
