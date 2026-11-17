// Object.getPrototypeOf on a value held in an untyped (checked-dynamic)
// container answers Node's prototype for every value representation: the
// primitive wrappers, strings, numbers, bigints and symbols box; arrays,
// records, functions, class instances and native built-ins (Date, Map, Set,
// WeakMap, WeakSet, typed arrays, Buffer, DataView, Promise) answer their
// class prototype; null and undefined throw. An isRecord test written over a
// store therefore classifies each value instead of throwing.
const values: any[] = [
  "s",
  1,
  true,
  1n,
  Symbol("sym"),
  {},
  [],
  () => 1,
  new Date(0),
  new Map(),
  new Set(),
  new WeakMap(),
  new WeakSet(),
  new Uint8Array(1),
  Buffer.from("x"),
  new DataView(new ArrayBuffer(1)),
  Promise.resolve(1),
  Object.create(null),
];
for (const value of values) {
  const prototype = Object.getPrototypeOf(value);
  console.log(typeof value, typeof prototype, prototype === Object.prototype, prototype === null);
}

class Point {
  x = 1;
}
const instance: any = new Point();
console.log("instance", Object.getPrototypeOf(instance) === Point.prototype);
const replaced: any = {};
Object.setPrototypeOf(replaced, null);
console.log("replaced", Object.getPrototypeOf(replaced) === null);
for (const missing of [null, undefined]) {
  try {
    Object.getPrototypeOf(missing);
  } catch (error) {
    console.log("missing", (error as Error).message);
  }
}

const store: Record<string, any> = {};
store.label = "general";
store.items = [1, 2];
store.meta = { open: true };
function isRecord(value: any): boolean {
  return value !== null && Object.getPrototypeOf(value) === Object.prototype;
}
console.log("isRecord", isRecord(store.label), isRecord(store.items), isRecord(store.meta));

// Function.prototype is a function whose own [[Prototype]] is
// Object.prototype, so walking past it ends the chain instead of cycling.
const fn: any = () => 1;
const fnPrototype: any = Object.getPrototypeOf(fn);
console.log(
  "function-chain",
  typeof fnPrototype,
  fnPrototype !== fn,
  Object.getPrototypeOf(fnPrototype) === Object.prototype,
  Object.getPrototypeOf(Object.getPrototypeOf(fnPrototype)) === null,
);

