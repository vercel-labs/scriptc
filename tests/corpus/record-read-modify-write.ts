// A dictionary read followed by a write of the same key: the write reuses
// the entry the read found when the object and the key are the same
// bindings and nothing in between can mutate the record. Present and absent
// keys, aliases, deletes, integer-like keys, boolean values and growth past
// the inline dictionary keep Node's values and insertion order.

function show(label: string, counts: Record<string, number>): void {
  const parts: string[] = [];
  for (const key in counts) parts.push(key + "=" + counts[key]);
  console.log(label, parts.join(" "));
}

// The single-statement counting form: the first occurrence inserts, later
// ones overwrite in place, so insertion order follows first sight.
const words = "the cat and the hat and the bat".split(" ");
const counts: Record<string, number> = {};
for (const w of words) counts[w] = (counts[w] ?? 0) + 1;
show("counts", counts);

// Keys that look like array indices sort ahead of the string keys.
const digits: Record<string, number> = {};
for (const d of ["10", "2", "b", "1", "a", "10", "2"]) digits[d] = (digits[d] ?? 0) + 1;
show("digits", digits);
console.log("keys", Object.keys(digits).join(","));

// The read as a declaration, then the write.
const sums: Record<string, number> = {};
for (let i = 0; i < 30; i++) {
  const key = "k" + (i % 7);
  const current = sums[key];
  sums[key] = current === undefined ? i : current + i;
}
show("sums", sums);

// A deleted key re-inserts at the end, as Node's dictionary does.
const reinsert: Record<string, number> = {};
for (const key of ["a", "b", "c"]) reinsert[key] = 1;
const a1 = reinsert["a"];
delete reinsert["a"];
reinsert["a"] = (a1 ?? 0) + 1;
show("reinsert", reinsert);
console.log("order", Object.keys(reinsert).join(","));

// Boolean values take the same overwrite path.
const flags: Record<string, boolean> = {};
for (const key of ["on", "off", "on", "on"]) flags[key] = !(flags[key] ?? false);
const flagParts: string[] = [];
for (const key in flags) flagParts.push(key + "=" + flags[key]);
console.log("flags", flagParts.join(" "));

// An alias of the same record updates the same entry.
const alias = counts;
const t = alias["the"]!;
alias["the"] = (t ?? 0) + 10;
show("alias", counts);

// A different key reads a different entry.
const other: Record<string, number> = {};
other["cat"] = (counts["cat"] ?? 0) + 100;
show("other", other);
show("counts again", counts);

// Growth past the inline dictionary: many distinct keys through the
// update path.
const grown: Record<string, number> = {};
for (let i = 0; i < 200; i++) {
  const key = "g" + (i % 90);
  grown[key] = (grown[key] ?? 0) + i;
}
let total = 0;
for (const key in grown) total += grown[key]!;
console.log("grown", Object.keys(grown).length, total);

// Inside a function, behind a condition, and with a missing key.
type Row = { cat: string; v: number };
function aggregate(rows: Row[]): Record<string, number> {
  const agg: Record<string, number> = {};
  for (const r of rows) {
    if (r.v < 0) continue;
    const key: string = r.cat;
    agg[key] = (agg[key] ?? 0) + r.v;
  }
  return agg;
}
const rows: Row[] = [
  { cat: "b", v: 2 },
  { cat: "a", v: 1 },
  { cat: "b", v: -5 },
  { cat: "c", v: 4 },
  { cat: "a", v: 8 },
];
show("aggregate", aggregate(rows));
