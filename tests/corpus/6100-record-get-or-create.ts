// Get-or-create over nested index-signature records without
// noUncheckedIndexedAccess: a missing key reads as undefined when the next
// statement tests the binding for absence, in every spelling of that test,
// at module scope and inside functions. A write with a computed key through
// a binding that may hold a missing element throws Node's TypeError after
// the key and the value evaluated.
type ExportMap = Record<string, Record<string, string>>;

interface Target {
  subpath: string;
  condition: string;
  target: string;
}

function build(targets: Target[]): { exports: ExportMap; unmapped: string[] } {
  const exports: ExportMap = {};
  const unmapped: string[] = [];
  for (const t of targets) {
    if (t.target === "") {
      unmapped.push(t.subpath);
      continue;
    }
    let entry = exports[t.subpath];
    if (entry === undefined) {
      entry = {};
      exports[t.subpath] = entry;
    }
    entry[t.condition] = `./${t.target}`;
    entry["types"] = `./${t.target}`;
  }
  return { exports: exports, unmapped: unmapped };
}

const result = build([
  { subpath: ".", condition: "import", target: "src/index.ts" },
  { subpath: ".", condition: "require", target: "src/index.ts" },
  { subpath: "./x", condition: "default", target: "" },
  { subpath: "./y", condition: "node", target: "src/y.ts" },
]);
console.log(JSON.stringify(result.exports), result.unmapped.join(","));

function group(words: string[]): Record<string, string[]> {
  const byInitial: Record<string, string[]> = {};
  for (const w of words) {
    const k = w.slice(0, 1);
    let list = byInitial[k];
    if (list == null) {
      list = [];
      byInitial[k] = list;
    }
    list.push(w);
  }
  return byInitial;
}
console.log(JSON.stringify(group(["apple", "avocado", "banana", "blueberry", "cherry"])));

function count(words: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const w of words) {
    const n = counts[w];
    if (typeof n === "undefined") counts[w] = 1;
    else counts[w] = n + 1;
  }
  return counts;
}
console.log(JSON.stringify(count(["a", "b", "a", "c", "a"])));

function lookup(table: Record<string, string>, key: string): string {
  const hit = table[key];
  if (hit !== undefined) return hit;
  return `<${key} missing>`;
}
console.log(lookup({ a: "A" }, "a"), lookup({ a: "A" }, "b"));

function rows(table: Record<string, Record<string, number>>, key: string, col: string): number {
  const row = table[key];
  if (row != undefined) return row[col] ?? -1;
  return -2;
}
console.log(rows({ r: { c: 3 } }, "r", "c"), rows({ r: { c: 3 } }, "r", "d"), rows({}, "x", "c"));

// Module scope.
const nested: Record<string, Record<string, number>> = {};
const key = process.argv.length > 99 ? "unused" : "k";
let slot = nested[key];
if (slot === undefined) {
  slot = {};
  nested[key] = slot;
}
slot[key] = 1;
slot["fixed"] = 2;
console.log(JSON.stringify(nested));

const names: Record<string, string> = { present: "yes" };
const missing = names[key];
if (!missing) console.log("falsy guard:", missing);
const present = names["present"];
if (present === void 0) console.log("unreachable");
else console.log("present:", present);

// A write with a computed key through a binding that may hold a missing
// array element throws Node's TypeError naming the key, after evaluating
// the key and the value.
function probe(tables: Record<string, string>[]): void {
  const firstTable = tables[0];
  const lastTable = tables[5];
  const pick = (k: string): string => {
    console.log("key", k);
    return k;
  };
  firstTable[pick("b")] = pick("second");
  console.log(JSON.stringify(firstTable));
  try {
    lastTable[pick("c")] = pick("value");
  } catch (e) {
    console.log((e as Error).name, (e as Error).message);
  }
}
probe([{ a: "first" }]);
