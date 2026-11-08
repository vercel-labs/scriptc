// ONE function object, several compiled instances. A generic declaration the
// program holds as more than one function object (pinned at two signatures,
// or pinned once and erased) keeps one identity in JavaScript, so `===`
// (typed, union-typed and dyn), `Object.is`, Map keys and `indexOf` all see
// the same function however the value was reached.
import * as lib from "./lib.ts";

interface Box<T> {
  v: T;
}

function unbox<T>(box: Box<T>): T {
  return box.v;
}

type NumFn = (box: Box<number>) => number;
type AnyFn = (box: Box<number>) => number | string;

// K1: the other operand is a `F | undefined` union, so the comparison has no
// single call signature to pin the declaration to.
let current: AnyFn | undefined;
function install(f: AnyFn): void {
  current = f;
}
install(unbox);
const pinned: NumFn = unbox;
console.log(current === unbox, current !== unbox, pinned === unbox);
console.log(current!({ v: 3 }), pinned({ v: 4 }));

// One signature, the same union operand.
let one: NumFn | undefined;
function installOne(f: NumFn): void {
  one = f;
}
installOne(unbox);
console.log(one === unbox, one!({ v: 5 }));

// Two pins at different signatures, an instantiation expression, a readonly
// property initializer, and an alias nothing rewrites.
const anyPin: (box: Box<number>) => unknown = unbox;
const i = unbox<number>;
const j = unbox<any>;
const alias = anyPin;
class Pins {
  readonly held: (box: Box<number>) => unknown = anyPin;
}
console.log(pinned === anyPin, i === j, pinned === alias, pinned === new Pins().held);

// The same declaration read through `unknown`: the runtime compares the
// closures' identity roots, so the two boxes are one function.
const ua: unknown = pinned;
const ub: unknown = unbox;
console.log(ua === ub, ua !== ub);

// Keys and searches: one function object, one key.
const registry = new Map<NumFn, string>();
registry.set(pinned, "pinned");
registry.set(unbox, "unbox");
console.log(registry.get(pinned), registry.get(unbox), registry.size, registry.has(unbox));
const list: NumFn[] = [pinned];
console.log(list.indexOf(unbox), list.includes(unbox), list.lastIndexOf(unbox));
console.log(Object.is(pinned, unbox), Object.is(unbox, unbox));

// The module-namespace value against a pinned slot of the same declaration.
const ns: Record<string, unknown> = lib;
const samePinned: (x: number) => number = lib.same;
console.log(ns["same"] === samePinned, samePinned(9), lib.same("t"));

// Distinct declarations are distinct functions, whatever their signatures.
function other<T>(box: Box<T>): T {
  return box.v;
}
const otherPinned: NumFn = other;
console.log(pinned === otherPinned, registry.has(otherPinned));
