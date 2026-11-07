// A member read off a builtin instance is the same function object the
// constructor's prototype holds: `stack.use === DisposableStack.prototype.use`.
// The instances answer their own method functions — the DisposableStack's carry
// the interface's brand errors, a Date's the Date receiver checks — so the
// prototype objects answer those same values instead of a second function of
// the same name, and a borrowed method still runs the interface it came from.

const stack = new DisposableStack();
console.log(
  "disposable",
  stack.use === DisposableStack.prototype.use,
  stack.adopt === DisposableStack.prototype.adopt,
  stack.defer === DisposableStack.prototype.defer,
  stack.move === DisposableStack.prototype.move,
  stack.dispose === DisposableStack.prototype.dispose,
  stack[Symbol.dispose] === DisposableStack.prototype[Symbol.dispose],
  stack[Symbol.dispose] === stack.dispose,
);
const otherStack = new DisposableStack();
console.log("disposable-shared", otherStack.use === stack.use, stack.use === stack.use);

const order = [];
const resource = { [Symbol.dispose]: () => order.push("used") };
const used = stack.use(resource);
const deferred = stack.defer(() => order.push("deferred"));
const moved = stack.move();
moved.dispose();
console.log("disposable-run", order.join(","), used === resource, deferred, stack.disposed);

const date = new Date(0);
console.log(
  "date",
  date.getTime === Date.prototype.getTime,
  date.setTime === Date.prototype.setTime,
  date.toISOString === Date.prototype.toISOString,
  date.toJSON === Date.prototype.toJSON,
  date.valueOf === Date.prototype.valueOf,
  date.toString === Date.prototype.toString,
  date.toUTCString === Date.prototype.toUTCString,
  date.getHours === Date.prototype.getHours,
);
const otherDate = new Date(1);
console.log("date-shared", otherDate.getTime === date.getTime, date.getTime === date.getTime);
console.log("date-run", Date.prototype.getTime.call(date), date.setTime.call(date, 7), date.getTime());
console.log("date-gmt", Date.prototype.toGMTString === Date.prototype.toUTCString);

const map = new Map([[1, 2]]);
console.log(
  "map",
  map.get === Map.prototype.get,
  map.set === Map.prototype.set,
  map.has === Map.prototype.has,
  map.delete === Map.prototype.delete,
  map.clear === Map.prototype.clear,
  map.keys === Map.prototype.keys,
  map.values === Map.prototype.values,
  map.entries === Map.prototype.entries,
  map.forEach === Map.prototype.forEach,
);
console.log("map-run", Map.prototype.get.call(map, 1), map.has(1), map.size);

const set = new Set([1]);
console.log(
  "set",
  set.add === Set.prototype.add,
  set.has === Set.prototype.has,
  set.delete === Set.prototype.delete,
  set.clear === Set.prototype.clear,
  set.values === Set.prototype.values,
);
console.log("set-run", Set.prototype.has.call(set, 1), set.size);

const weakMap = new WeakMap();
const weakSet = new WeakSet();
console.log(
  "weak",
  weakMap.get === WeakMap.prototype.get,
  weakMap.set === WeakMap.prototype.set,
  weakSet.add === WeakSet.prototype.add,
  weakSet.has === WeakSet.prototype.has,
);

const plain = { a: 1 };
const text = "abc";
const other = "xyz";
console.log(
  "inherited",
  plain.hasOwnProperty === Object.prototype.hasOwnProperty,
  Object.prototype.hasOwnProperty.call(plain, "a"),
  text.slice === String.prototype.slice,
  String.prototype.slice.call(text, 1),
  text.startsWith === String.prototype.startsWith,
  text.slice === other.slice,
);
