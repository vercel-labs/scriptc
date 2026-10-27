// String-keyed dictionaries (`Record<string, number>`) walked with for-in,
// Object.keys, Object.values and Object.entries while entries are added,
// updated and deleted: per-category totals, a pruning pass and a merge.
let seed = 777;
function random(): number {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed / 4294967296;
}

const scale = Number(process.argv[2] ?? "1");
const categories = 4000;
const counts: Record<string, number> = {};
for (let i = 0; i < Math.floor(200000 * scale); i++) {
  const key = "c" + Math.floor(random() * categories);
  counts[key] = (counts[key] ?? 0) + 1;
}

let walked = 0;
let sum = 0;
for (let pass = 0; pass < 40; pass++) {
  for (const key in counts) {
    walked++;
    sum += counts[key]!;
  }
}

// Prune: delete the small categories during the walk, including keys the
// walk has not reached yet.
let pruned = 0;
for (const key in counts) {
  const n = counts[key]!;
  if (n < 45) {
    delete counts[key];
    pruned++;
  }
  const ahead = "c" + ((Number(key.slice(1)) + 1) % categories);
  if (n > 60 && ahead in counts && counts[ahead]! < 45) {
    delete counts[ahead];
    pruned++;
  }
}

// Merge into a second dictionary and read it back every way.
const merged: Record<string, number> = {};
for (const key of Object.keys(counts)) merged[key.toUpperCase()] = counts[key]! * 2;
let values = 0;
for (const v of Object.values(merged)) values += v;
let entries = 0;
for (const [key, v] of Object.entries(merged)) entries += key.length + v;

console.log(
  `walked ${walked}, sum ${sum}, pruned ${pruned}, kept ${Object.keys(counts).length}, values ${values}, entries ${entries}`,
);
