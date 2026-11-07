// A variadic function stored under a fixed signature is called with that
// signature's parameters by typed code. Made untyped again it is the
// original function: untyped code calls it with every argument it passes,
// directly, through an object that holds it, as what a promise settles
// with, and after a cast to another signature. It stays one function for
// equality, searches, `length` and `name`.
import { callMember, callWithThree, hold } from "./callers.mjs";

function counter(): (...args: unknown[]) => number {
  return function counted(...args: unknown[]): number {
    return args.length;
  };
}
const one: (x: number) => number = counter();
console.log(one(7));
console.log(callWithThree(one));
console.log(hold(one).f(1, 2, 3, 4));

// Through an untyped value and a cast to a longer signature.
const untyped: unknown = one;
console.log(typeof untyped, (untyped as (a: number, b: number, c: number) => number)(1, 2, 3));
const again = untyped as (x: number) => number;
console.log(again(9), again === one, [one].indexOf(again), one.length, one.name);

// Through an object and a record that hold it in a member.
const holder: { f: (x: number) => number; tag: string } = { f: counter(), tag: "h" };
console.log(holder.f(1), callMember(holder));
class Box {
  f: (x: number) => number;
  constructor(f: (x: number) => number) {
    this.f = f;
  }
}
const box = new Box(counter());
console.log(box.f(1), callMember(box));
const seen: unknown = holder;
console.log((seen as { f: (a: number, b: number) => number }).f(1, 2));

// As what a promise settles with, under a longer signature.
const later: Promise<(a: number, b: number) => number> = Promise.resolve(one);
later.then((f) => console.log(f(1, 2)));

// A void slot and a promise result keep working the same way.
function quiet(): (...args: unknown[]) => unknown {
  return (...args: unknown[]): unknown => {
    console.log("quiet", args.length);
    return undefined;
  };
}
const none: () => void = quiet();
none();
console.log(callWithThree(none));

// A list Object.values makes is native, and its methods call a callback
// with the parameters it declares. A constant that holds a variadic
// function under a shorter type goes to the list's untyped view instead,
// which calls the original with the element, the index and the list.
const table: Record<string, object> = { a: { n: 3 }, b: { n: 1 } };
const counted = (...args: unknown[]): number => args.length;
const first: (v: object) => number = counted;
console.log(Object.values(table).map(first).join(","));
const threeSeen = (...args: unknown[]): boolean => args.length === 3 && typeof args[1] === "number";
const keep: (v: object) => boolean = threeSeen;
console.log(Object.values(table).filter(keep).length);
const shown = (...args: unknown[]): void => console.log("each", args.length, typeof args[1]);
const each: (v: object) => void = shown;
Object.values(table).forEach(each);
console.log(Object.values(table).some(keep), Object.values(table).every(keep));

// A record that holds a stored variadic function may go through a container
// that only keeps it: the container calls no member, and the member read
// back is called with what its type names.
interface Lock {
  name: string;
  release: () => void;
}
const locks: Lock[] = [{ name: "a", release: quiet() }];
const byName = new Map(locks.map((lock) => [lock.name, lock]));
byName.get("a")?.release();
const unique = new Set(locks);
for (const lock of unique) lock.release();
for (const lock of Array.from(locks)) lock.release();
