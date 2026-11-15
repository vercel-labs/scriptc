// util.promisify.custom on a statically typed function: a truthy function
// there is what util.promisify answers — the same function, not a wrapper —
// whatever its signature, and it is marked with the key itself; a falsy
// value leaves the wrapper, which carries the key with the wrapper as its
// value. Both the truthiness test and the value validated are reads of the
// same property, so a getter sees two when it answers truthy and one when
// it answers falsy, per promisify call, and an accessor that throws
// propagates out of util.promisify before a wrapper exists. A truthy
// non-function throws Node's ERR_INVALID_ARG_TYPE naming the property and
// the received type.
import * as util from "node:util";

const key = util.promisify.custom as any;

function flags(target: any): string {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor === undefined) return "none";
  return `${typeof descriptor.value} ${descriptor.writable} ${descriptor.enumerable} ${descriptor.configurable}`;
}

function add(a: number, b: number, callback: (error: Error | null, value: number) => void): void {
  callback(null, a + b);
}

// The typed custom: the answer is this function itself.
const custom = function customAdd(a: number, b: number): Promise<number> {
  return Promise.resolve((a + b) * 10);
};
Object.defineProperty(add as any, key, { value: custom, configurable: true });
const promoted = util.promisify(add);
console.log("identity:", promoted === custom, "name:", (promoted as any).name);
console.log("flags:", flags(promoted as any));
console.log("key:", key === Symbol.for("nodejs.util.promisify.custom"));

function plain(a: number, b: number, callback: (error: Error | null, value: number) => void): void {
  callback(null, a + b);
}
const wrapper = util.promisify(plain);
console.log("wrapper:", wrapper !== plain, "flags:", flags(wrapper as any));
console.log("wrapper props:", (wrapper as any).name, (wrapper as any).length);
console.log("wrapper own:", Object.getOwnPropertyNames(wrapper as any).join(","));
console.log("twice:", util.promisify(wrapper as any) === wrapper);

// The wrapper takes the original's own descriptors, extra members included.
function withExtra(a: number, callback: (error: Error | null, value: number) => void): void {
  callback(null, a);
}
Object.defineProperty(withExtra as any, "extra", {
  value: 42,
  writable: true,
  enumerable: true,
  configurable: true,
});
const copied = util.promisify(withExtra);
const copiedDyn: any = copied;
const copiedDescriptor = Object.getOwnPropertyDescriptor(copiedDyn, "extra");
console.log(
  "copied:",
  copiedDyn.extra,
  copiedDyn.name,
  copiedDyn.length,
  Object.getOwnPropertyNames(copiedDyn).join(","),
  `${copiedDescriptor?.writable} ${copiedDescriptor?.enumerable} ${copiedDescriptor?.configurable}`,
);

// Falsy values on a typed function leave the wrapper, which is marked.
const falsy = [null, undefined, 0, "", false];
for (const value of falsy) {
  const fn = (a: number, callback: (error: Error | null, value: number) => void): void => {
    callback(null, a);
  };
  Object.defineProperty(fn as any, key, { value, configurable: true });
  const out = util.promisify(fn);
  const descriptor = Object.getOwnPropertyDescriptor(out as any, key);
  console.log(
    "falsy:",
    value === null ? "null" : typeof value,
    out !== fn,
    descriptor?.value === out,
    descriptor?.enumerable,
  );
}

// A truthy non-function throws, before any wrapper is built.
const rejected = [42, "x", { a: 1 }, true];
for (const value of rejected) {
  const fn = (a: number, callback: (error: Error | null, value: number) => void): void => {
    callback(null, a);
  };
  Object.defineProperty(fn as any, key, { value, configurable: true });
  try {
    util.promisify(fn);
    console.log("no throw:", typeof value);
  } catch (error: any) {
    console.log("throw:", error.name, error.code, error.message);
  }
}

// A throwing accessor propagates out of util.promisify, before a wrapper
// exists.
function withThrowingGetter(a: number, callback: (error: Error | null, value: number) => void): void {
  callback(null, a);
}
Object.defineProperty(withThrowingGetter as any, key, {
  get() {
    throw new RangeError("boom");
  },
  configurable: true,
});
try {
  util.promisify(withThrowingGetter);
  console.log("no getter throw");
} catch (error: any) {
  console.log("getter throw:", error.name, error.message);
}

// An accessor is read once for the truthiness test and once for the value.
let truthyReads = 0;
const getterCustom = (a: number): Promise<number> => Promise.resolve(a + 100);
function withGetter(a: number, callback: (error: Error | null, value: number) => void): void {
  callback(null, a);
}
Object.defineProperty(withGetter as any, key, {
  get() {
    truthyReads++;
    return getterCustom;
  },
  configurable: true,
});
const viaGetter = util.promisify(withGetter);
console.log("getter:", truthyReads, viaGetter === getterCustom);

let falsyReads = 0;
function withFalsyGetter(a: number, callback: (error: Error | null, value: number) => void): void {
  callback(null, a);
}
Object.defineProperty(withFalsyGetter as any, key, {
  get() {
    falsyReads++;
    return undefined;
  },
  configurable: true,
});
const viaFalsyGetter = util.promisify(withFalsyGetter);
console.log("falsy getter:", falsyReads, viaFalsyGetter !== withFalsyGetter, flags(viaFalsyGetter as any));

// The property is consulted at promisify time, not at call time.
const mutable = (a: number): Promise<number> => Promise.resolve(a * 3);
function mutating(a: number, callback: (error: Error | null, value: number) => void): void {
  callback(null, a * 3);
}
Object.defineProperty(mutating as any, key, { value: mutable, configurable: true });
const captured = util.promisify(mutating);
Object.defineProperty(mutating as any, key, { value: 0, configurable: true });
console.log("captured:", captured === mutable);

// Two functions of the same type keep their own answers.
const shared = (a: number, b: number): Promise<number> => Promise.resolve(a * b);
function first(a: number, b: number, callback: (error: Error | null, value: number) => void): void {
  callback(null, a * b);
}
function second(a: number, b: number, callback: (error: Error | null, value: number) => void): void {
  callback(null, a * b);
}
Object.defineProperty(first as any, key, { value: shared, configurable: true });
console.log("separate:", util.promisify(first) === shared, util.promisify(second) !== (shared as any));

// A bound method promisifies like the method itself.
class Counter {
  readonly base: number;
  constructor(base: number) {
    this.base = base;
  }
  read(a: number, callback: (error: Error | null, value: number) => void): void {
    callback(null, this.base + a);
  }
}
const counter = new Counter(10);
const bound = counter.read.bind(counter);
const boundCustom = (a: number): Promise<number> => Promise.resolve(counter.base * a);
Object.defineProperty(bound as any, key, { value: boundCustom, configurable: true });
const boundPromoted = util.promisify(bound);
console.log("bound:", boundPromoted === boundCustom);

// A custom that rejects rejects the awaited call.
const failing = (a: number): Promise<number> => Promise.reject(new RangeError(`no ${a}`));
function rejectedCustom(a: number, callback: (error: Error | null, value: number) => void): void {
  callback(null, a);
}
Object.defineProperty(rejectedCustom as any, key, { value: failing, configurable: true });
const failPromoted = util.promisify(rejectedCustom);

async function main(): Promise<void> {
  console.log("custom call:", await promoted(2, 3));
  console.log("wrapper call:", await wrapper(2, 3));
  console.log("getter call:", await viaGetter(1));
  console.log("falsy getter call:", await viaFalsyGetter(4));
  console.log("captured call:", await captured(5));
  console.log("shared call:", await util.promisify(first)(6, 7));
  console.log("bound call:", await boundPromoted(8));
  try {
    await failPromoted(9);
  } catch (error: any) {
    console.log("reject:", error.name, error.message);
  }
}

void main();
