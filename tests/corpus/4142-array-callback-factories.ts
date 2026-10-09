// Callbacks produced by factories and held in captured constants. Every
// factory call returns the same code with its own environment, so a direct
// call must still pass the right captures; factories with several shapes
// stay on the ordinary indirect path.
interface Row {
  id: number;
  name: string;
  score: number;
}

const rows: Row[] = [
  { id: 1, name: "cy", score: 30 },
  { id: 2, name: "ab", score: 10 },
  { id: 3, name: "ab", score: 30 },
  { id: 4, name: "dd", score: 20 },
];

function compareBy(keys: string[]): (a: Row, b: Row) => number {
  return (a, b) => {
    for (const key of keys) {
      let d = 0;
      if (key === "name") d = a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      else if (key === "score") d = b.score - a.score;
      else d = a.id - b.id;
      if (d !== 0) return d;
    }
    return 0;
  };
}
for (const keys of [["name", "id"], ["score", "name", "id"], ["id"]]) {
  console.log(keys.join(">"), rows.slice().sort(compareBy(keys)).map((row) => row.id).join(","));
}

function scaled(factor: number, offset: number): (row: Row) => number {
  return (row) => row.score * factor + offset;
}
let total = 0;
for (let round = 0; round < 3; round++) {
  const scorer = scaled(round + 1, round * 100);
  const mapped = rows.map((row) => ({ id: row.id, value: scorer(row) }));
  total += mapped.reduce((sum, entry) => sum + entry.value, 0);
  console.log("round", round, mapped.map((entry) => entry.value).join(","));
}
console.log("total", total);

function pick(ascending: boolean): (a: Row, b: Row) => number {
  if (ascending) return (a, b) => a.score - b.score || a.id - b.id;
  return (a, b) => b.score - a.score || b.id - a.id;
}
console.log("asc", rows.slice().sort(pick(true)).map((row) => row.id).join(","));
console.log("desc", rows.slice().sort(pick(false)).map((row) => row.id).join(","));

let comparisons = 0;
function counting(limit: number): (a: Row, b: Row) => number {
  return (a, b) => {
    comparisons++;
    if (comparisons > limit) throw new Error(`limit ${limit}`);
    return a.id - b.id;
  };
}
try {
  rows.slice().reverse().sort(counting(2));
} catch (error) {
  if (error instanceof Error) console.log("sort threw", error.message, comparisons > 2);
}

const threshold = 15;
const above = (row: Row): boolean => row.score > threshold;
console.log("captured", rows.filter((row) => above(row)).map((row) => row.name).join(","));
