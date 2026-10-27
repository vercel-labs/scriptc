// Comparators that chain number-field terms with `||` (`a.k - b.k || a.j -
// b.j`), optionally over optional fields with a number default (`(a.k ?? 0)
// - (b.k ?? 0)`), sort records and class instances by several keys: equal
// keys fall through to the next term, ties keep their order, and NaN and -0
// keys, holes and comparators with other terms match Node.
interface Row {
  id: number;
  group: number;
  score?: number;
  weight: number;
  label: string;
}

class Entry {
  id: number;
  major: number;
  minor: number;
  constructor(id: number, major: number, minor: number) {
    this.id = id;
    this.major = major;
    this.minor = minor;
  }
}

let seed = 11;
function random(): number {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed / 4294967296;
}

function ids(rows: { id: number }[]): string {
  let hash = 0;
  for (const row of rows) hash = (Math.imul(hash, 31) + row.id) | 0;
  return rows.length + ":" + hash;
}

function makeRows(n: number, groups: number, scored: number): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < n; i++) {
    const row: Row = {
      id: i,
      group: Math.floor(random() * groups),
      weight: Math.floor(random() * 4) / 2,
      label: "r" + i,
    };
    if (random() < scored) row.score = Math.floor(random() * 20) - 5;
    rows.push(row);
  }
  return rows;
}

for (const [groups, scored] of [
  [1, 1],
  [3, 0.5],
  [10, 0.9],
  [1000, 0.2],
]) {
  const parts: string[] = [];
  for (const n of [0, 1, 2, 5, 16, 47, 48, 49, 200, 5000]) {
    const rows = makeRows(n, groups!, scored!);
    const two = rows.toSorted((a, b) => a.group - b.group || a.weight - b.weight);
    const mixed = rows.toSorted((a, b) => b.group - a.group || a.weight - b.weight);
    const three = rows.toSorted(
      (a, b) => (b.score ?? 0) - (a.score ?? 0) || a.group - b.group || b.weight - a.weight,
    );
    const ternary = rows.toSorted(
      (a, b) => (a.group < b.group ? -1 : a.group > b.group ? 1 : 0) || b.id - a.id,
    );
    const missingLast = rows.toSorted((a, b) => (a.score ?? 99) - (b.score ?? 99) || a.id - b.id);
    const single = rows.toSorted((a, b) => (b.score ?? -1) - (a.score ?? -1));
    const inPlace = rows.slice();
    inPlace.sort((p, q) => q.weight - p.weight || p.group - q.group);
    parts.push(
      [two, mixed, three, ternary, missingLast, single, inPlace].map((sorted) => ids(sorted)).join("/"),
    );
  }
  console.log(groups, scored, parts.join(" "));
}

// Ties on every key keep the input order.
const tied = makeRows(24, 2, 0.5);
console.log(
  tied
    .toSorted((a, b) => a.group - b.group || (a.score ?? 0) - (b.score ?? 0))
    .map((r) => r.label)
    .join(","),
);

// Class instances sort by their fields.
const entries: Entry[] = [];
for (let i = 0; i < 300; i++) entries.push(new Entry(i, i % 7, (i * 13) % 5));
console.log(ids(entries.toSorted((a, b) => a.major - b.major || b.minor - a.minor)));
console.log(
  entries
    .toSorted((a, b) => b.major - a.major || a.minor - b.minor || a.id - b.id)
    .slice(0, 12)
    .map((e) => `${e.id}:${e.major}:${e.minor}`)
    .join(" "),
);

// A NaN or -0 key in a later term, and infinities in the first, sort
// through the comparator.
function keyed(values: [number, number][]): Row[] {
  return values.map(([group, weight], id) => ({ id, group, weight, label: "k" + id }));
}
const nan = keyed([
  [1, 3],
  [0, NaN],
  [1, 1],
  [0, 2],
  [1, NaN],
  [0, 0],
  [2, 5],
  [1, 2],
]);
console.log(nan.toSorted((a, b) => a.group - b.group || a.weight - b.weight).map((r) => r.id).join(","));
console.log(nan.toSorted((a, b) => b.group - a.group || b.weight - a.weight).map((r) => r.id).join(","));
const zeros = keyed(Array.from({ length: 30 }, (_, i): [number, number] => [i % 3, i % 4 === 0 ? -0 : (i % 4) - 2]));
console.log(zeros.toSorted((a, b) => a.group - b.group || a.weight - b.weight).map((r) => r.id).join(","));
const infinite = keyed([
  [Infinity, 2],
  [-Infinity, 1],
  [Infinity, 1],
  [0, 3],
  [-Infinity, 0],
  [Infinity, 0],
]);
console.log(
  infinite.toSorted((a, b) => a.group - b.group || a.weight - b.weight).map((r) => r.id).join(","),
);

// A default that differs per operand is not one key; the comparator runs.
const uneven = makeRows(40, 3, 0.5);
console.log(ids(uneven.toSorted((a, b) => (a.score ?? 0) - (b.score ?? 1) || a.id - b.id)));

// A chain with a term that is not a key difference calls the comparator.
const labelled = makeRows(60, 4, 1);
let calls = 0;
const byLabel = labelled.toSorted((a, b) => {
  calls++;
  return a.group - b.group || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
});
console.log(ids(byLabel), calls > 0);

// Holes and a sparse tail take the snapshot sort.
const holes: Row[] = makeRows(20, 3, 0.5);
holes.length = 26;
holes.sort((a, b) => a.group - b.group || (b.score ?? 0) - (a.score ?? 0));
console.log(holes.length, holes.map((r) => (r === undefined ? "-" : r.id)).join(","));
