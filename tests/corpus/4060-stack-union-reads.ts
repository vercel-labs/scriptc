// Optional element reads, Map.get results, and wrapped literals consumed
// by tests, comparisons, and `??` without a heap union box: holes, present
// values, sparse and noncanonical indices, scalar arms (-0, NaN, false),
// reference identity, closure locals, and mutation inside the `??` default.

// boolean[] truthiness over dense, hole, out-of-range, and sparse slots.
const flags: boolean[] = new Array<boolean>(8).fill(false);
flags[3] = true;
flags[6] = true;
flags[10] = true;
const flagIndexes = [0, 3, 6, 7, 8, 9, 10, 11, -1, 1.5, 2 ** 32, NaN];
let flagHits = "";
for (const i of flagIndexes) {
  if (flags[i]) flagHits += `T${i} `;
  else flagHits += `F${i} `;
}
console.log("flags", flagHits.trim());
const sparseFlags: boolean[] = [];
sparseFlags[3000000] = true;
sparseFlags[2999999] = false;
console.log("sparse", !!sparseFlags[3000000], !!sparseFlags[2999999], !!sparseFlags[2999998]);

// A small sieve: the hot `if (composite[i])` probe.
function sieve(limit: number): number {
  const composite: boolean[] = new Array<boolean>(limit + 1).fill(false);
  let count = 0;
  for (let i = 2; i <= limit; i++) {
    if (composite[i]) continue;
    count++;
    for (let j = i * i; j <= limit; j += i) composite[j] = true;
  }
  return count;
}
console.log("primes", sieve(10000));

// number[] reads with `??`, `===`, and truthiness: false-y values are not nullish.
const nums: number[] = [0, -0, NaN, 7, 2.5];
nums[7] = 9;
for (let i = 0; i < 9; i++) {
  const d = nums[i] ?? -1;
  const zero = nums[i] === 0;
  const nan = nums[i] !== nums[i];
  const truthy = nums[i] ? "t" : "f";
  const undef = nums[i] === undefined;
  console.log("num", i, Object.is(d, -0) ? "-0" : d, zero, nan, truthy, undef);
}

// boolean `??` keeps a stored false.
const bools: boolean[] = [false, true];
bools[3] = false;
console.log("bool??", bools[0] ?? true, bools[1] ?? false, bools[2] ?? true, bools[3] ?? true);

// string[] reads compared against literals and other reads.
const words: string[] = ["alpha", "", "gamma"];
words[4] = "epsilon";
for (let i = 0; i < 6; i++) {
  const w = words[i];
  console.log(
    "word",
    i,
    w === "gamma",
    w === undefined,
    w ?? "(missing)",
    words[i] === "alpha",
    words[i] ? "t" : "f",
    words[i] === words[0],
  );
}

// Reference identity is preserved through the stack box.
interface Item {
  id: number;
}
const a: Item = { id: 1 };
const b: Item = { id: 1 };
const items: Item[] = [a, b, a];
items[5] = b;
const fallback: Item = { id: -1 };
for (let i = 0; i < 7; i++) {
  console.log("item", i, items[i] === a, items[i] === b, (items[i] ?? fallback).id, items[i] === undefined);
}

// The `??` default may mutate the array; the earlier read keeps its value.
const queue: string[] = ["x"];
const first = queue[0] ?? "none";
const second = queue[1] ?? (queue.length = 0, "cleared");
console.log("queue", first, second, queue.length, queue[0] ?? "empty");
const owned: string[] = ["kept" + String(queue.length)];
console.log("owned", owned[0] === (owned.pop(), "kept0"), owned.length);

// Closure bodies: loop bindings and locals compared to literals.
let holesSeen = 0;
function compareBy(keys: string[]): (x: Item, y: Item) => number {
  return (x, y) => {
    for (const key of keys) {
      let d = 0;
      if (key === "id") d = x.id - y.id;
      else if (key === "neg") d = y.id - x.id;
      else if (key === undefined) holesSeen++;
      if (d !== 0) return d;
    }
    return 0;
  };
}
const holeyKeys: string[] = ["skip"];
holeyKeys[2] = "neg";
const sorted = [{ id: 3 }, { id: 1 }, { id: 2 }].sort(compareBy(["skip", "id"]));
console.log("sorted", sorted.map((x) => x.id).join(","));
const holey = [{ id: 3 }, { id: 1 }, { id: 2 }].sort(compareBy(holeyKeys));
console.log("holey", holey.map((x) => x.id).join(","), holesSeen > 0);
const pick = (list: number[], i: number): string => {
  const v = list[i];
  if (v === undefined) return "u";
  return v === 0 ? "zero" : String(v ?? "never");
};
console.log("pick", pick([0, 5], 0), pick([0, 5], 1), pick([0, 5], 2));

// Map.get consumed by `??` and comparisons.
const counts = new Map<string, number>([
  ["a", 0],
  ["b", 2],
]);
const names = new Map<number, string>([[1, "one"]]);
console.log("map", counts.get("a") ?? -1, counts.get("z") ?? -1, counts.get("b") === 2, names.get(1) === "one");
console.log("map2", names.get(2) === undefined, names.get(2) ?? "none", counts.get("a") ? "t" : "f");

// Projection-only union parameters may receive stack boxes from callers:
// `??` and `===` inside the callee must borrow them, never retain them.
function joinOr(next: string | null, prev: string | undefined, d: string): string {
  const tail = next === "stop" ? "!" : "";
  return `${next ?? d}|${prev ?? d}${tail}|${prev === next}`;
}
console.log("params", joinOr("a", undefined, "-"), joinOr(null, "z", "-"), joinOr("stop", "stop", "-"));
const seen = ["q"];
console.log("params2", joinOr(seen[0] ?? null, seen[1], "_"), joinOr(null, seen[0], "_"));
