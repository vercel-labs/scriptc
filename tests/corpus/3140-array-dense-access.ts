// Dense element fast paths keep the runtime's answers for every index that
// is not a canonical in-range dense slot: holes, present undefined, sparse
// indices, noncanonical numeric keys, and reads at or past the length.

// Numeric reads with proven-integer, double, and noncanonical indices.
const nums: number[] = [10, 20, 30, 40];
let sum = 0;
for (let i = 0; i < nums.length; i++) sum += nums[i]!;
console.log("sum", sum);
const idx: number[] = [0, 1.5, -1, -0, NaN, Infinity, -Infinity, 3, 4, 100, 2 ** 32 - 1, 2 ** 53];
for (const k of idx) console.log("read " + String(k), nums[k]);
console.log("neg zero", nums[-0], Object.is(nums[-0], 10));

// Writes inside length, at length (append), and past length (holes).
const grow: (number | undefined)[] = [1, 2];
grow[1] = 5;
grow[2] = 7;
grow[grow.length] = 9;
grow[7] = 11;
console.log("grow", grow.length, JSON.stringify(grow));
for (let i = 0; i < grow.length + 2; i++) console.log("grow " + i, i in grow, grow[i]);
grow[5] = undefined;
console.log("present undefined", 5 in grow, grow[5], 6 in grow);

// Noncanonical numeric keys are ordinary properties.
const props: number[] = [1, 2, 3];
props[-1] = 42;
props[1.5] = 43;
props[-0] = 44;
console.log("props", props.length, props[-1], props[1.5], props[0], JSON.stringify(props));

// Truncation and regrowth leave holes, never stale values.
const shrink: (number | undefined)[] = [1, 2, 3, 4, 5, 6];
shrink.length = 2;
shrink[4] = 50;
for (let i = 0; i < shrink.length; i++) console.log("shrink " + i, i in shrink, shrink[i]);

// Sparse storage beyond the dense limit.
const sparse: number[] = [];
sparse[3000000] = 7;
sparse[2] = 3;
console.log("sparse", sparse.length, sparse[3000000], sparse[2], 3 in sparse, sparse[2999999]);
sparse[3000000] = sparse[3000000]! + 1;
console.log("sparse write", sparse[3000000]);

// Boolean arrays.
const flags: boolean[] = new Array<boolean>(6).fill(false);
for (let i = 0; i < flags.length; i += 2) flags[i] = true;
let on = 0;
for (let i = 0; i < flags.length; i++) if (flags[i]) on++;
console.log("flags", on, JSON.stringify(flags));
const sieve: boolean[] = [];
sieve[3] = true;
console.log("bool holes", sieve.length, 0 in sieve, sieve[0], sieve[3]);

// Reference elements: reads retain, writes release the replaced value.
const words: string[] = ["alpha", "beta", "gamma"];
const kept = words[1]!;
words[1] = "delta" + String(words.length);
words[1] = words[1]! + "!";
words[3] = kept + kept;
console.log("words", kept, JSON.stringify(words));
for (let r = 0; r < 3; r++) {
  for (let i = 0; i < words.length; i++) words[i] = words[i]!.toUpperCase() + String(r);
}
console.log("words loop", JSON.stringify(words));
const maybe: (string | undefined)[] = ["a"];
maybe[3] = "d";
for (let i = 0; i < 5; i++) console.log("maybe " + i, maybe[i] ?? "<none>");
for (const w of maybe) console.log("of", w);

interface Point {
  x: number;
  y: number;
}
const points: Point[] = [];
for (let i = 0; i < 5; i++) points[i] = { x: i, y: i * i };
const p = points[2]!;
points[2] = { x: -1, y: -1 };
console.log("points", p.x, p.y, points[2]!.x, points.length);
let total = 0;
for (const q of points) total += q.x + q.y;
for (let i = points.length - 1; i >= 0; i--) total += points[i]!.y;
console.log("points total", total);

const grid: number[][] = [[1, 2], [3, 4]];
const row = grid[1]!;
grid[1] = [5, 6, 7];
row[0] = 30;
console.log("grid", JSON.stringify(grid), JSON.stringify(row));

const mixed: (string | number)[] = [1, "two", 3];
mixed[1] = 2;
mixed[4] = "five";
for (let i = 0; i < mixed.length; i++) {
  const m = mixed[i];
  console.log("mixed " + i, i in mixed, m === undefined ? "undefined" : typeof m === "string" ? "string:" + m : "number:" + String(m));
}

// Fractional and negative computed indices from arithmetic.
const table: number[] = [0, 1, 4, 9, 16, 25];
for (let i = 0; i < 6; i++) console.log("half " + i, table[i / 2], table[i - 3]);

// Conditions on scalar element reads: holes, present undefined, indices
// past the length, noncanonical indices, zero, and NaN are all falsy.
const truth: boolean[] = [true, false, true];
truth[5] = true;
const truthIdx: number[] = [0, 1, 2, 3, 4, 5, 6, -1, 0.5, NaN, -0];
let truthy = "";
for (const k of truthIdx) truthy += truth[k] ? "T" : "f";
for (let i = 0; i < truth.length + 2; i++) truthy += truth[i] && i > 0 ? "1" : "0";
let w = 0;
while (truth[w]) w++;
console.log("bool truth", truthy, w);
const numsTruth: number[] = [1, 0, NaN, -2, 0.5];
numsTruth[7] = 3;
let numTruthy = "";
for (let i = -1; i < numsTruth.length + 1; i++) numTruthy += numsTruth[i] ? "T" : "f";
for (const k of truthIdx) numTruthy += numsTruth[k] || numsTruth[k] === 0 ? "1" : "0";
console.log("num truth", numTruthy);
function pickFlags(n: number): boolean[] {
  const out: boolean[] = [];
  for (let i = 0; i < n; i += 2) out[i] = i % 4 === 0;
  return out;
}
let fromCall = "";
for (let i = 0; i < 8; i++) fromCall += pickFlags(6)[i] ? "T" : "f";
console.log("call truth", fromCall);

// Number() of string element reads: missing slots convert like undefined.
const cells: string[] = ["12", " 3.5 ", "", "x", "0x10", "-0", "1e3"];
cells[9] = "7";
const parsed: number[] = [];
for (let i = -1; i < cells.length + 1; i++) parsed.push(Number(cells[i]));
for (const k of [0.5, NaN, -0, 2 ** 32]) parsed.push(Number(cells[k]));
console.log("number cells", parsed.join(","), Object.is(Number(cells[5]), -0));
const rows = "a,1,2.5\nb,,x\nc,4".split("\n");
let rowSum = 0;
for (let r = 0; r < rows.length; r++) {
  const cols = rows[r]!.split(",");
  const v = Number(cols[1]) + Number(cols[2]);
  rowSum += Number.isNaN(v) ? 100 : v;
}
console.log("row sum", rowSum, Number("1,2".split(",")[3]));
