// @requires-libnode
// Island functions as callbacks where the call can fail or is not a plain
// call: a function that throws inside `map` and `sort`, an async function
// under `Promise.all` and `then`, and a method read off an island object,
// which is unbound as in JavaScript (`this` is undefined in strict code)
// until the program binds it.
import { counter, failLater, later, makeScale, parsePositive, strictCompare } from "ordkit";

function describe(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  return `${e.name}: ${e.message} ${e instanceof RangeError} ${e instanceof TypeError}`;
}

// A callback that throws: the island's error reaches the program's catch.
console.log(["1", "2"].map(parsePositive).join(","));
try {
  console.log(["3", "-4", "5"].map(parsePositive).join(","));
} catch (e) {
  console.log(describe(e));
}
try {
  console.log(["b", "a", "b"].sort(strictCompare).join(","));
} catch (e) {
  console.log(describe(e));
}
const parse = parsePositive;
try {
  parse("zero");
} catch (e) {
  console.log(describe(e));
}
const typedParse: (s: string) => number = parsePositive;
try {
  typedParse("0");
} catch (e) {
  console.log(describe(e));
}
console.log(["b", "a", "c"].sort(strictCompare).join(","));

// Async functions.
const next = later;
console.log((await Promise.all([1, 2, 3].map(later))).join(","), await next(9));
console.log(await Promise.resolve(40).then(later));
const settled = await Promise.allSettled([1, 2].map(failLater));
console.log(settled.map((s) => (s.status === "rejected" ? describe(s.reason) : "ok")).join(" | "));
try {
  await Promise.all([5].map(failLater));
} catch (e) {
  console.log(describe(e));
}

// Method references: unbound, bound, and called on the object.
const describeUnbound = counter.describe;
console.log(describeUnbound(1), counter.describe(2), [3, 4].map(counter.describe).join(","));
const add = counter.add;
try {
  console.log(add(1));
} catch (e) {
  console.log(e instanceof TypeError);
}
try {
  console.log([1].map(counter.add).join(","));
} catch (e) {
  console.log(e instanceof TypeError);
}
const bound = counter.add.bind(counter);
console.log(bound(5), [1, 2].map((k) => counter.add(k)).join(","));
const scale = makeScale(3);
const apply = scale.apply;
try {
  console.log(apply(2));
} catch (e) {
  console.log(e instanceof TypeError);
}
console.log(scale.apply(2), [1, 2].map((n) => scale.apply(n)).join(","), scale.apply.bind(scale)(4));
