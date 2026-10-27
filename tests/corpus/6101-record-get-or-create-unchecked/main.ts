// Get-or-create over nested index-signature records under
// noUncheckedIndexedAccess: after the presence guard the binding is still
// stored with its undefined arm, and reads, writes and absence probes with
// computed keys go through it (an internal compiler error before).
type ExportMap = Record<string, Record<string, string>>;

function build(rows: { k: string; c: string; v: string }[]): ExportMap {
  const map: ExportMap = {};
  for (const r of rows) {
    let entry = map[r.k];
    if (entry === undefined) {
      entry = {};
      map[r.k] = entry;
    }
    entry[r.c] = r.v;
  }
  return map;
}
console.log(
  JSON.stringify(
    build([
      { k: "a", c: "x", v: "1" },
      { k: "a", c: "y", v: "2" },
      { k: "b", c: "x", v: "3" },
    ]),
  ),
);

function touch(map: ExportMap, k: string): string {
  let e = map[k];
  if (e === undefined) {
    e = { [k]: "init" };
    map[k] = e;
  }
  const before = e[k] ?? "none";
  e[k] = e[k] + "!";
  return before + (k in e ? "+" : "-");
}
const m: ExportMap = {};
console.log(touch(m, "a"), touch(m, "a"), touch(m, "b"), JSON.stringify(m));

function tally(counts: Record<string, Record<string, number>>, group: string, item: string): void {
  let row = counts[group];
  if (!row) {
    row = {};
    counts[group] = row;
  }
  row[item] = (row[item] ?? 0) + 1;
}
const counts: Record<string, Record<string, number>> = {};
for (const [g, i] of [
  ["fruit", "apple"],
  ["fruit", "pear"],
  ["veg", "kale"],
  ["fruit", "apple"],
]) {
  tally(counts, g!, i!);
}
console.log(JSON.stringify(counts));

// Module scope.
const top: ExportMap = {};
const key = process.argv.length > 99 ? "unused" : "k";
let slot = top[key];
if (slot === undefined) {
  slot = {};
  top[key] = slot;
}
slot[key] = "v";
console.log(JSON.stringify(top), slot[key], slot["other"] ?? "missing");
