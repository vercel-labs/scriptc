// @transform-types
// A union type that reaches itself through a container (its own array arm,
// an index signature, a Map, a second alias, a union inside an array inside
// a union), held where a class holds values: a field, a static field, a
// constructor parameter property, a generic class's field, a method
// parameter and a method local. The backend's ownership planners ask of
// every such type which classes a value of it can lead to; the question
// ends, and the values read, write, print and serialize as they do in Node.

type Outline = string | number | Outline[];
type Sheet = string | number | boolean | null | undefined | Sheet[] | { [name: string]: Sheet };
type Row = number | Column[];
type Column = string | Row[];
type Shelf = number | Map<string, Shelf>;
type Mixed = number | (string | Mixed)[];

function outline(v: Outline): string {
  if (typeof v === "number") return "n" + v;
  if (typeof v === "string") return "s" + v;
  return "[" + v.map(outline).join(",") + "]";
}
function sheet(v: Sheet): string {
  if (v === null) return "null";
  if (v === undefined) return "undef";
  if (typeof v === "string") return "s" + v;
  if (typeof v === "number") return "n" + v;
  if (typeof v === "boolean") return "b" + v;
  if (Array.isArray(v)) return "[" + v.map(sheet).join(",") + "]";
  return (
    "{" +
    Object.keys(v)
      .map((k) => k + ":" + sheet(v[k]))
      .join(",") +
    "}"
  );
}
function row(v: Row): string {
  return typeof v === "number" ? "n" + v : "(" + v.map(column).join(",") + ")";
}
function column(v: Column): string {
  return typeof v === "string" ? "s" + v : "<" + v.map(row).join(",") + ">";
}
function shelf(v: Shelf): number {
  if (typeof v === "number") return v;
  let n = 0;
  for (const inner of v.values()) n += shelf(inner);
  return n;
}
function mixed(v: Mixed): string {
  if (typeof v === "number") return "n" + v;
  return "[" + v.map((e) => (typeof e === "string" ? "s" + e : mixed(e))).join(",") + "]";
}

// A field, an array of the union, and a method parameter.
class Notebook {
  pages: Sheet[] = [];
  latest: Sheet = undefined;
  add(page: Sheet): void {
    this.pages.push(page);
    this.latest = page;
  }
}
const notebook = new Notebook();
console.log(typeof notebook.latest, sheet(notebook.latest));
const firstPage: Sheet = { k: [1, undefined, "x", null, true], m: { n: 2 } };
notebook.add(firstPage);
console.log(notebook.latest === firstPage, sheet(notebook.latest));
notebook.add("t");
console.log(notebook.pages.length, typeof notebook.latest, sheet(notebook.pages[0]));
console.log(notebook.pages);

// Parameter properties, one for each of two aliases that reach each other.
class Ledger {
  constructor(
    public rows: Row,
    readonly head: Column,
  ) {}
}
const ledger = new Ledger(["a", [1, ["b"]]], [2, ["c", [3]]]);
console.log(row(ledger.rows), column(ledger.head));
ledger.rows = 9;
console.log(row(ledger.rows), JSON.stringify(ledger.head));
console.log(ledger.head);

// A union with its own array arm, and a union in an array in a union.
class Folder {
  body: Outline = 0;
  extra: Mixed = 0;
}
const folder = new Folder();
const chapters: Outline = [1, "two", [3, ["four"]]];
folder.body = chapters;
folder.extra = [1, "two", [3, "four", [5]]];
console.log(folder.body === chapters, Array.isArray(folder.body), outline(folder.body));
console.log(mixed(folder.extra), JSON.stringify(folder.body), JSON.stringify(folder.extra));
console.log(folder.body, folder.extra);

// A generic class instantiated at the union.
class Crate<T> {
  item: T;
  constructor(item: T) {
    this.item = item;
  }
}
const crate = new Crate<Outline>(["in", [1]]);
console.log(outline(crate.item));
crate.item = 5;
console.log(outline(crate.item));

// A static field and an instance field of a union that reaches itself
// through a Map.
class Depot {
  static stock: Shelf = 0;
  floor: Shelf = new Map<string, Shelf>();
}
const depot = new Depot();
if (typeof depot.floor !== "number") {
  depot.floor.set(
    "sub",
    new Map<string, Shelf>([
      ["a", 3],
      ["b", 4],
    ]),
  );
  depot.floor.set("c", 5);
}
Depot.stock = depot.floor;
console.log(shelf(depot.floor), shelf(Depot.stock), Depot.stock === depot.floor);

// The union reaches the class that holds it.
type Wood = Grove | Wood[];
class Grove {
  inner: Wood | null = null;
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
}
function names(w: Wood): string {
  if (Array.isArray(w)) return "[" + w.map(names).join(",") + "]";
  return w.name + (w.inner === null ? "" : ":" + names(w.inner));
}
const oak = new Grove("oak");
oak.inner = [new Grove("ash"), [new Grove("elm")]];
console.log(names([oak, new Grove("fir")]));

// A class of immutable, singly owned nodes, and a function that holds one
// of them beside a parameter and a local of the union.
class Twig {
  readonly left: Twig | null;
  readonly right: Twig | null;
  constructor(left: Twig | null, right: Twig | null) {
    this.left = left;
    this.right = right;
  }
}
function grow(depth: number): Twig {
  return depth === 0 ? new Twig(null, null) : new Twig(grow(depth - 1), grow(depth - 1));
}
function count(t: Twig): number {
  return t.left === null || t.right === null ? 1 : 1 + count(t.left) + count(t.right);
}
function size(v: Outline): number {
  if (typeof v === "number" || typeof v === "string") return 1;
  let n = 0;
  for (const e of v) n += size(e);
  return n;
}
function weigh(t: Twig, extra: Outline): number {
  const seen: Outline = [extra, "x"];
  return count(t) + size(seen);
}
console.log(weigh(grow(4), [1, ["two", 3]]));

// A nullable union whose one arm is a container of the union: the value is
// that container's pointer, so a question about the union is a question
// about a container of itself.
type Nest = Nest[] | null;
type Tags = Map<string, Tags> | undefined;
class Burrow {
  den: Nest = null;
  marks: Tags = undefined;
  constructor(public side: Nest) {}
}
function depth(v: Nest): number {
  if (v === null) return 0;
  let most = 0;
  for (const inner of v) most = Math.max(most, depth(inner));
  return most + 1;
}
function tally(t: Tags): number {
  if (t === undefined) return 0;
  let n = t.size;
  for (const inner of t.values()) n += tally(inner);
  return n;
}
const burrow = new Burrow([null]);
burrow.den = [null, [[null]]];
burrow.marks = new Map<string, Tags>([
  ["a", new Map<string, Tags>([["b", undefined]])],
  ["c", undefined],
]);
const hollow: { hole: Nest } = { hole: [[null]] };
const dens: Nest[] = [null, [null]];
const byName = new Map<string, Nest>([["k", [[], null]]]);
console.log(depth(burrow.den), depth(burrow.side), tally(burrow.marks), depth(hollow.hole));
console.log(dens.length, depth(dens[1] ?? null), depth(byName.get("k") ?? null));
console.log(JSON.stringify(burrow.den), burrow.den);
// The array holds itself: a cycle the collector has to find.
const ring: Nest[] = [];
ring.push(ring);
console.log(ring.length, ring[0] === ring);
