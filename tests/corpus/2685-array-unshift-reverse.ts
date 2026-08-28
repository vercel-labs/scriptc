// Static Array.prototype.unshift and mutating reverse: variadic insertion
// preserves source order, returns the new length, and evaluates every
// argument before the first mutation. reverse mutates in place and returns
// the receiver identity.
const nums: number[] = [3, 4];
console.log(nums.unshift(1, 2), nums.join(","));
console.log(nums.unshift(), nums.join(","));

const observed: number[] = [10];
console.log(observed.unshift(observed.length, observed.length));
console.log(observed.join(","));

// A single same-element array or Set spread keeps iteration order. The
// self-spread form snapshots the original values before front insertion.
const fromArray: number[] = [7, 8];
console.log(nums.unshift(...fromArray), nums.join(","));
const fromSet = new Set<number>([5, 6]);
console.log(nums.unshift(...fromSet), nums.join(","));
const self: number[] = [1, 2, 3];
console.log(self.unshift(...self), self.join(","));

// reverse returns THE receiver: mutating the result mutates the original.
const reversed = nums.reverse();
console.log(nums.join(","));
reversed.push(99);
console.log(nums.join(","));
console.log(reversed.reverse().unshift(0), nums.join(","));

// Scalar and refcounted element representations all use the same slot
// mutation without copying or releasing the elements.
const bits: boolean[] = [false, true];
bits.unshift(true, false);
console.log(bits.reverse().join(","));

interface Row {
  id: number;
  label: string;
}
const rows: Row[] = [{ id: 2, label: "b" }];
const first: Row = { id: 1, label: "a" };
rows.unshift(first);
const sameRows = rows.reverse();
sameRows[1]!.label = "A";
console.log(rows[0]!.id, rows[1]!.label, rows.length);

const optional: (string | undefined)[] = ["tail"];
optional.unshift(undefined, "head");
optional.reverse();
console.log(optional.length, optional[0] ?? "-", optional[1] ?? "-", optional[2] === undefined);

console.log([1, 2, 3].reverse().join("-"));
const empty: string[] = [];
const emptyResult = empty.reverse();
emptyResult.unshift("x");
console.log(empty.join(","));
