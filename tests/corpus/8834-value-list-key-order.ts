// Which values Object.values lists over a checked-dynamic object, and in
// which order: integer-like keys first in ascending order, then the other
// string keys in insertion order; no symbol keys, no inherited or
// non-enumerable properties. The lists feed array methods directly.
type Dict = Record<string, unknown>;

const ordered: Dict = {};
ordered["b"] = "b";
ordered["10"] = "ten";
ordered["a"] = "a";
ordered["2"] = "two";
ordered["-1"] = "minus";
ordered["01"] = "padded";
ordered["4294967295"] = "max+1";
ordered["4294967294"] = "max";
ordered["1.5"] = "float";
console.log(Object.values(ordered).map((value) => String(value)).join(","));
console.log(Object.keys(ordered).join(","));

// Symbol keys and non-enumerable properties are skipped.
const tagged: Dict = { plain: 1 };
(tagged as Record<symbol, unknown>)[Symbol("hidden")] = "symbol";
Object.defineProperty(tagged, "quiet", { value: "quiet", enumerable: false });
Object.defineProperty(tagged, "loud", { value: "loud", enumerable: true });
console.log(Object.values(tagged).map((value) => String(value)).join(","));

// Inherited properties are skipped; a prototype-less object lists its own.
const base = { inherited: "base" };
const derived: Dict = Object.create(base);
derived["own"] = "own";
console.log(
  Object.values(derived).map((value) => String(value)).join(","),
  Object.values(derived).filter((value) => value === "base").length,
);
const bare: Dict = Object.create(null);
bare["x"] = 1;
bare["y"] = 2;
console.log(Object.values(bare).reduce((sum: number, value) => sum + (value as number), 0));

// A getter runs once per walk, in key order.
let reads = 0;
const computed: Dict = { first: 1 };
Object.defineProperty(computed, "second", {
  enumerable: true,
  get() {
    reads++;
    return reads * 10;
  },
});
computed["third"] = 3;
console.log(Object.values(computed).map((value) => Number(value)).join(","), reads);
console.log(Object.values(computed).filter((value) => Number(value) > 5).length, reads);

// The list is taken before the first callback runs: a callback that
// changes the dictionary changes neither the walk nor the list.
const live: Dict = { a: 1, b: 2, c: 3 };
const walked = Object.values(live).map((value, index) => {
  if (index === 0) {
    delete live["b"];
    live["d"] = 4;
    live["c"] = 30;
  }
  return Number(value);
});
console.log(walked.join(","), Object.values(live).map((value) => Number(value)).join(","));
Object.values(live).forEach((value) => {
  live[`k${String(value)}`] = value;
});
console.log(Object.keys(live).join(","));

// A frozen object lists as any other.
const frozen: Dict = Object.freeze({ z: 26, y: 25, 1: "one", list: [1, 2] });
console.log(Object.values(frozen).map((value) => String(value)).join(","), Object.isFrozen(frozen));
console.log(Object.values(frozen).flatMap((value) => (Array.isArray(value) ? value : [])).join(","));

// Arrays, strings and functions as the operand.
const holes: unknown = [1, , 3];
console.log(Object.values(holes as object).map((value) => String(value)).join(","));
console.log(Object.values("héé" as unknown as object).map((value) => String(value)).join("."));
const fn: unknown = function named() {};
(fn as Dict)["extra"] = "prop";
console.log(Object.values(fn as object).map((value) => String(value)).join(","));

// Object.fromEntries of a chain: a later duplicate key wins the value and
// the first keeps the position; `__proto__` is an own key; integer-like
// keys order first.
function index(d: Record<string, object>): Record<string, object> {
  return Object.fromEntries(Object.values(d).map((value) => [(value as { key: string }).key, value]));
}
const indexed = index({
  one: { key: "b", n: 1 },
  two: { key: "7", n: 2 },
  three: { key: "__proto__", n: 3 },
  four: { key: "b", n: 4 },
  five: { key: "3", n: 5 },
});
console.log(Object.keys(indexed).join(","), JSON.stringify(indexed));
console.log(
  Object.getPrototypeOf(indexed) === Object.prototype,
  Object.prototype.hasOwnProperty.call(indexed, "__proto__"),
);

// Object.fromEntries from iterables that are not arrays.
const fromMap: Record<string, object> = Object.fromEntries(
  new Map<string, object>([
    ["m2", { v: 2 }],
    ["m1", { v: 1 }],
  ]),
);
function* pairs(): Generator<[string, object]> {
  yield ["g1", { v: 1 }];
  yield ["g0", { v: 0 }];
  yield ["g1", { v: 11 }];
}
const fromGenerator: Record<string, object> = Object.fromEntries(pairs());
const fromSet: Record<string, object> = Object.fromEntries(
  new Set<[string, object]>([
    ["s", { v: 1 }],
    ["t", { v: 2 }],
  ]),
);
console.log(JSON.stringify(fromMap), JSON.stringify(fromGenerator), JSON.stringify(fromSet));
console.log(
  Object.values(fromGenerator)
    .map((value) => (value as { v: number }).v)
    .join(","),
);
