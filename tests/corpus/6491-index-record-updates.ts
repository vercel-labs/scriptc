// Compound assignment and ++/-- through a string key of an
// index-signature record: a missing entry reads as undefined, which every
// numeric operator turns into NaN, and the write inserts or replaces it.
const counts: Record<string, number> = {};
const words = "the cat and the hat and the bat".split(" ");
for (const w of words) {
  counts[w] ??= 0;
  counts[w]++;
}
console.log(JSON.stringify(counts));

const sums: { [key: string]: number } = { a: 1, b: 2 };
sums["a"] += 10;
sums.b *= 3;
const key = "a";
sums[key] -= 1;
console.log(JSON.stringify(sums));

// A missing entry: undefined op number is NaN, and the value form yields it.
console.log((sums["missing"] += 1), sums["missing"], Number.isNaN(sums["missing"]));
const later = sums["gone"]++;
console.log(later, sums["gone"], Object.keys(sums).join(","));

// Totals keyed by a runtime string, with the key and right side evaluated once.
let trace = "";
function name(n: string): string {
  trace += `key:${n};`;
  return n;
}
function size(n: number): number {
  trace += `rhs:${n};`;
  return n;
}
const totals: Record<string, number> = { disk: 0, net: 0 };
const samples: [string, number][] = [
  ["disk", 4],
  ["net", 7],
  ["disk", 2],
];
for (const [k, v] of samples) totals[name(k)] += size(v);
console.log(JSON.stringify(totals), trace);
const before = totals["net"]--;
const after = --totals["net"];
console.log(before, after, totals["net"]);
