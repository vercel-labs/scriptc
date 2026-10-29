// A comparator may declare more parameters than `sort` passes: the surplus
// positions receive the native undefined value, exactly as in a two-argument
// call. The imported `(a, b, loose) => …` comparators and lambdas with an
// optional or defaulted trailing parameter take this shape, and a lambda
// whose own signature already spells its completed ABI is a value wherever
// its slot converts.

type Comparer = (a: string, b: string, loose?: boolean) => number;

const seen: string[] = [];
const cmp: Comparer = (a, b, loose) => {
  seen.push(loose === undefined ? "absent" : String(loose));
  return a < b ? -1 : a > b ? 1 : 0;
};

const versions = ["1.9.0", "1.10.0", "1.2.0"];
console.log([...versions].sort(cmp).join(","));
console.log(seen.length > 0 && seen.every((entry) => entry === "absent"));
console.log(versions.join(","));

// `toSorted` adapts the same way and leaves the receiver untouched.
console.log(versions.toSorted(cmp).join(","), versions.join(","));

// Direct calls through the value complete the same parameters.
console.log(cmp("a", "b"), cmp("b", "a"), cmp("a", "a", true));

// An inline comparator with an optional surplus parameter sorts by number.
const nums = [3, 1, 2];
const descending = (a: number, b: number, dir?: boolean): number =>
  dir === undefined ? b - a : a - b;
console.log(nums.toSorted(descending).join(","));
console.log([...nums].sort((a, b, dir?: boolean) => (dir ? a - b : b - a)).join(","));
console.log(nums.join(","));

// A defaulted surplus parameter keeps its default when sort omits it.
const withDefault = (a: string, b: string, scale = 1): number =>
  (a < b ? -1 : a > b ? 1 : 0) * scale;
console.log(["b", "a", "c"].sort(withDefault).join(""));
console.log(withDefault("a", "b"), withDefault("a", "b", 3));

// A one-parameter comparator is still a prefix of the slot.
console.log(["d", "c", "a"].sort((left) => left.charCodeAt(0) - 97).join(","));
