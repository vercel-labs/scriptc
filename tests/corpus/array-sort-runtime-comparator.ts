// Comparator sorts over number and reference element types: stability across
// natural runs, insertion runs and merges; comparators with fewer parameters;
// NaN, infinite and fractional results; inconsistent comparators (checked as
// permutations, since their order is implementation-defined); exceptions that
// leave the receiver untouched; holes for sort and toSorted; and element
// identity and lifetime after sorting.

interface Item {
  key: number;
  id: number;
  label: string;
}

class Box {
  weight: number;
  tag: string;
  constructor(weight: number, tag: string) {
    this.weight = weight;
    this.tag = tag;
  }
}

function by<T>(score: (value: T) => number): (a: T, b: T) => number {
  return (a, b) => score(a) - score(b);
}

const items: Item[] = [];
for (let i = 0; i < 700; i++) {
  // Ascending runs, descending runs and a sawtooth tail, with many ties.
  const key = i < 200 ? i % 37 : i < 400 ? (400 - i) % 23 : (i * 7919) % 11;
  items.push({ key, id: i, label: `item${i}` });
}
const byKey = items.slice().sort(by((item: Item) => item.key));
let stable = true;
for (let i = 1; i < byKey.length; i++) {
  const a = byKey[i - 1]!,
    b = byKey[i]!;
  if (a.key > b.key || (a.key === b.key && a.id > b.id)) stable = false;
}
console.log("stable", stable, byKey[0]!.label, byKey[699]!.label, byKey[350]!.id);
console.log("identity", byKey[0] === items[byKey[0]!.id], items[0]!.label);

const sorted = items.toSorted((a, b) => b.key - a.key || b.id - a.id);
console.log(
  "toSorted",
  sorted.length,
  sorted.slice(0, 5).map((item) => item.id).join(","),
  items[0]!.id,
);

// Strings, tuples, class instances and a union without an undefined arm.
const words = ["pear", "fig", "banana", "kiwi", "apple", "plum", "date", "lime"];
const lengthOrder = (a: string, b: string) => a.length - b.length;
console.log(words.slice().sort(lengthOrder).join(" "));
const pairs: [string, number][] = [
  ["b", 2],
  ["a", 2],
  ["c", 1],
  ["d", 3],
];
console.log(pairs.sort((a, b) => b[1] - a[1]).map((pair) => pair.join(":")).join(" "));
const boxes = [new Box(3, "x"), new Box(1, "y"), new Box(3, "z"), new Box(2, "w")];
console.log(boxes.toSorted(by((box: Box) => box.weight)).map((box) => box.tag).join(""));
const mixed: (string | number)[] = [3, "b", 1, "a", 2];
const mixedOrder = (a: string | number, b: string | number) =>
  typeof a === typeof b ? (a < b ? -1 : a > b ? 1 : 0) : typeof a === "number" ? -1 : 1;
console.log(mixed.sort(mixedOrder).join(","));

// Numbers, including signed zeros that compare equal.
const nums = [5, -0, 3, 0, 9, 1, 4, 8, 2, 7, 6];
console.log(nums.slice().sort((a, b) => a - b).map((n) => (Object.is(n, -0) ? "-0" : n)).join(","));
console.log(nums.slice().sort((a, b) => (b - a) / 3).join(","));
console.log(nums.slice().sort(() => 0).join(","));
console.log(nums.slice().sort(() => NaN).join(","));
console.log(nums.slice().sort((a, b) => (a < b ? -Infinity : a > b ? Infinity : 0)).join(","));

// Inconsistent comparators still produce a permutation of the input.
let state = 17;
const chaos = (_a: number, _b: number): number => {
  state = (state * 48271) % 2147483647;
  return (state % 3) - 1;
};
const shuffled = nums.slice().sort(chaos);
console.log("permutation", shuffled.length, shuffled.slice().sort((a, b) => a - b).join(","));
const unary = (a: number) => a - 4;
console.log("unary", nums.slice().sort(unary).slice().sort((a, b) => a - b).join(","));

// A throwing comparator leaves the receiver exactly as it was.
const victims = items.slice(0, 40);
const before = victims.map((item) => item.id).join(",");
let calls = 0;
try {
  victims.sort((a, b) => {
    if (++calls === 25) throw new RangeError("stop");
    return a.key - b.key;
  });
} catch (error) {
  console.log((error as Error).name, (error as Error).message);
}
console.log("unchanged", victims.map((item) => item.id).join(",") === before);
try {
  victims.toSorted((): number => {
    throw new TypeError("never");
  });
} catch (error) {
  console.log((error as Error).name, (error as Error).message);
}

// Holes: sort moves them to the end; toSorted materializes undefined.
const sparse: Item[] = [];
sparse[4] = items[9]!;
sparse[1] = items[3]!;
sparse[7] = items[1]!;
const holes = sparse.slice().sort(by((item: Item) => item.id));
console.log(holes.length, 0 in holes, 2 in holes, 3 in holes, holes[0]!.id, holes[2]!.id);
const filled = sparse.toSorted((a, b) => b.id - a.id);
console.log(filled.length, 5 in filled, filled[5] === undefined, filled[0]!.id);

// Repeated references and small arrays.
const shared = items[42]!;
const repeated = [shared, items[1]!, shared, items[0]!];
const repeatedSorted = repeated.sort(by((item: Item) => item.id));
console.log(repeatedSorted.map((item) => item.id).join(","), repeatedSorted[2] === shared);
console.log([7].sort(() => 1).join(","), ([] as number[]).sort(() => 1).length);
console.log([2, 1].sort((a, b) => a - b).join(","), ["b", "a"].sort((a, b) => b.localeCompare(a)).join(""));
