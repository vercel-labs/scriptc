// Union-typed locals inside closure bodies: `for...of` bindings (which may
// observe holes as undefined), strict equality against literals, locals
// reassigned between arms, and bindings that escape into nested closures.
// Comparator closures drive Array.prototype.sort/toSorted, including a
// throwing comparator whose exception must propagate unchanged.

interface Row {
  name: string;
  team: string;
  score: number;
}

function compareBy(keys: string[]): (a: Row, b: Row) => number {
  return (a, b) => {
    for (const key of keys) {
      let d = 0;
      if (key === "team") d = a.team < b.team ? -1 : a.team > b.team ? 1 : 0;
      else if (key === "score") d = b.score - a.score;
      else if (key === "name") d = a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      else if (key === undefined) d = 0;
      else throw new Error(`unknown key ${key}`);
      if (d !== 0) return d;
    }
    return 0;
  };
}

const rows: Row[] = [
  { name: "ana", team: "red", score: 3 },
  { name: "bo", team: "blue", score: 3 },
  { name: "cy", team: "red", score: 5 },
  { name: "dee", team: "blue", score: 1 },
  { name: "eli", team: "red", score: 3 },
  { name: "fay", team: "green", score: 5 },
];
const show = (list: Row[]): string => list.map((r) => r.name).join(",");

console.log(show(rows.slice().sort(compareBy(["team", "score"]))));
console.log(show(rows.toSorted(compareBy(["score", "name"]))));
console.log(show(rows.slice().sort(compareBy([]))));

// A hole in the key list is read as undefined by for...of.
const sparse: string[] = ["score"];
sparse[2] = "name";
console.log(sparse.length, show(rows.slice().sort(compareBy(sparse))));

// An exception thrown by the comparator propagates and leaves the
// receiver untouched.
const before = show(rows);
try {
  rows.sort(compareBy(["team", "bogus"]));
  console.log("not reached");
} catch (error) {
  console.log("caught", (error as Error).message, show(rows) === before);
}

// A union local reassigned inside a closure body, compared both ways.
function classify(values: (string | undefined)[]): () => string {
  return () => {
    const out: string[] = [];
    for (const value of values) {
      let current: string | undefined = value;
      if (current === "skip") current = undefined;
      const tag = current === undefined ? "none" : "x" === current ? "ex" : current;
      out.push(tag);
    }
    return out.join("|");
  };
}
const items: (string | undefined)[] = ["a", undefined, "skip", "x"];
items[5] = "z";
console.log(classify(items)());

// A loop binding captured by a nested closure must survive the iteration.
interface Thunk {
  run: () => string;
}
function collect(names: string[]): (index: number) => string {
  return (index) => {
    const later: Thunk[] = [];
    for (const name of names) {
      if (name === names[index]) later.push({ run: () => `${name}@${index}` });
    }
    return later.map((thunk) => thunk.run()).join(";");
  };
}
const collected = collect(["p", "q", "p"]);
console.log(collected(0), collected(1), collected(2));
