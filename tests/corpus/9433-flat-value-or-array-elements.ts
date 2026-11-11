// .flat() over an array whose elements are each a value or an array of such
// values, and over a fixed tuple of arrays. Each element is decided by what
// it holds when the call is made: a value is kept, an array contributes its
// elements in order; holes of either array are skipped. The result is a new
// array of the values themselves.
interface Crate {
  id: number;
  label: string;
}

const words: (string | string[])[] = ["oak", ["elm", "ash"], [], "fir", ["yew"]];
const flatWords = words.flat();
console.log(flatWords.length, flatWords.join(","));
const empty: (string | string[])[] = [];
console.log(empty.flat().length);

const counts: (number | number[])[] = [1, [2, 3], [], 4];
console.log(counts.flat().reduce((s, n) => s + n, 0), counts.flat());
const flags: (boolean | boolean[])[] = [[true, false], false];
console.log(flags.flat().join(","));

const one: Crate = { id: 1, label: "bolts" };
const crates: (Crate | Crate[])[] = [one, [{ id: 2, label: "nuts" }, { id: 3, label: "pins" }], []];
const flatCrates = crates.flat();
console.log(flatCrates.length, flatCrates.map((c) => c.label).join(","), flatCrates[0] === one);

// The depth: zero copies, one or more flattens the one level there is.
const depth: (string | string[])[] = ["x", ["y", "z"]];
console.log(depth.flat(0).length, depth.flat(1).join(""), depth.flat(3).join(""));

// Holes are skipped at both levels.
const inner: string[] = [];
inner[0] = "b";
inner[2] = "c";
const sparse: (string | string[])[] = [];
sparse[0] = "a";
sparse[2] = inner;
sparse[4] = "d";
const dense = sparse.flat();
console.log(sparse.length, inner.length, dense.length, JSON.stringify(dense));

// The result is a copy: later changes of an inner array do not reach it.
const shared = ["p", "q"];
const twice: (string | string[])[] = [shared, "r", shared];
const before = twice.flat();
shared.push("late");
console.log(before.join(","), twice.flat().join(","));

// As a call result, in a spread and in a for-of head.
function groups(n: number): (string | string[])[] {
  const all: (string | string[])[] = [];
  for (let i = 0; i < n; i++) all.push(i % 2 === 0 ? `g${i}` : [`g${i}a`, `g${i}b`]);
  return all;
}
console.log(["first", ...groups(3).flat(), "last"].join(" "));
for (const name of groups(4).flat()) console.log(name);
console.log(groups(5).flat().map((s) => s.length).join(","), groups(0).flat().length);

// A fixed tuple of arrays: its positions are read when the call is made.
const north: Crate[] = [one];
const south: Crate[] = [];
const east: Crate[] = [{ id: 2, label: "nuts" }, { id: 3, label: "pins" }];
const both: [Crate[], Crate[]] = [east, north];
const all = both.flat();
console.log(all.length, all[0] === east[0], all.map((c) => c.id).join(","));
const three = [north, south, east] as const;
console.log(three.flat().length, three.flat(1).length, three.flat(0).length);
const rows: [number[], number[]] = [[1], [2]];
const flatRows = rows.flat();
rows[0].push(9);
rows[1] = [7, 8];
console.log(flatRows.join(","), rows.flat().join(","));
const sidesT: [string, string] = ["left", "right"];
console.log(sidesT.flat().join(","));
