// push() appends inline while the dense storage has room and keeps the
// runtime append when it is full; element writes keep the runtime path for
// holes, growth, and sparse indices. Lengths, holes, and reference counts
// must match Node at every boundary.

const nums: number[] = [];
let lengths = 0;
for (let i = 0; i < 100; i++) lengths += nums.push(i * 1.5);
console.log("nums", nums.length, lengths, nums[0], nums[99]);

// Return value used directly, and NaN / -0 payloads survive the store.
const special: number[] = [1];
console.log("push ret", special.push(NaN), special.push(-0), special.push(Infinity));
console.log("special", Object.is(special[2], -0), Number.isNaN(special[1]!), special[3]);

// Truncation, then pushes land at the new length.
const trunc: number[] = [1, 2, 3, 4, 5, 6, 7, 8];
trunc.length = 3;
trunc.push(40);
trunc.push(50);
console.log("trunc", trunc.length, JSON.stringify(trunc));

// Extending length creates holes; push lands after them.
const ext: number[] = [1, 2];
ext.length = 6;
ext.push(7);
console.log("ext", ext.length, 2 in ext, 5 in ext, 6 in ext, ext[6]);

// Writes creating holes, then push past them.
const holes: number[] = [];
holes[3] = 3;
holes.push(4);
holes[10] = 10;
holes.push(11);
console.log("holes", holes.length, JSON.stringify(holes), 0 in holes, 4 in holes, 9 in holes);

// pop() then push reuses the freed slot.
const pp: string[] = ["a", "b", "c"];
const popped = pp.pop();
pp.push("d" + popped);
pp.push("e");
console.log("pop push", pp.length, pp.join(","));

// Boolean and reference elements (strings, records, nested arrays).
const flags: boolean[] = [];
for (let i = 0; i < 37; i++) flags.push(i % 3 === 0);
console.log("flags", flags.length, flags.filter((f) => f).length, flags[36]);
interface Rec {
  id: number;
  tag: string;
}
const recs: Rec[] = [];
for (let i = 0; i < 50; i++) recs.push({ id: i, tag: "t" + (i % 7) });
const shared = recs[10]!;
recs.length = 5;
recs.push(shared);
recs.push(shared);
console.log("recs", recs.length, recs[5]!.id, recs[6] === shared, shared.tag);
const grid: number[][] = [];
for (let r = 0; r < 4; r++) {
  const row: number[] = [];
  for (let c = 0; c < 9; c++) row.push(r * c);
  grid.push(row);
}
console.log("grid", grid.length, grid[3]!.length, grid[3]![8], JSON.stringify(grid[2]));

// Overwrite references in place (release of the replaced value).
const words: string[] = ["x", "y", "z"];
for (let i = 0; i < 1000; i++) words[i % 3] = "w" + i;
console.log("words", words.join(","));

// Cross the dense storage limit with push and keep counting correctly.
const big: number[] = [];
const limit = (1 << 20) + 17;
for (let i = 0; i < limit; i++) big.push(i & 1023);
let bigSum = 0;
for (let i = 0; i < big.length; i += 4099) bigSum += big[i]!;
console.log("big", big.length, big[limit - 1], bigSum, big.push(5), big[limit]);
big.length = 10;
big.push(99);
console.log("big trunc", big.length, big[10], 11 in big);
