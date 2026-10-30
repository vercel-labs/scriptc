// Sets and Maps keyed by unions whose arms compare by identity, beside
// undefined and null keys.

class Leaf {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
}

class Branch {
  readonly name: string;
  readonly children: Leaf[];
  constructor(name: string, children: Leaf[]) {
    this.name = name;
    this.children = children;
  }
}

const a = new Leaf("a");
const b = new Leaf("b");
const twin = new Leaf("a");

// A class or undefined.
const leaves = new Set<Leaf | undefined>();
for (const item of [a, undefined, b, a, undefined, twin]) leaves.add(item);
console.log(leaves.size, leaves.has(a), leaves.has(undefined), leaves.has(new Leaf("b")));
console.log([...leaves].map((leaf) => (leaf === undefined ? "undefined" : leaf.name)).join(","));
leaves.delete(undefined);
console.log(leaves.size, leaves.has(undefined));
console.log(leaves);

// A class, null or undefined, as Map keys.
const counts = new Map<Leaf | null | undefined, number>();
for (const item of [a, null, undefined, b, null, a])
  counts.set(item, (counts.get(item) ?? 0) + 1);
console.log(counts.get(a), counts.get(null), counts.get(undefined), counts.get(twin));
for (const [key, count] of counts)
  console.log(key === null ? "null" : key === undefined ? "undefined" : key.name, count);
console.log(Array.from(counts.keys()).length, counts.has(null), counts.delete(null), counts.has(null));
console.log(counts);

// Two classes or undefined.
const nodes: (Leaf | Branch | undefined)[] = [a, new Branch("root", [a, b]), undefined, b];
const seen = new Set(nodes);
seen.add(nodes[1]);
seen.add(undefined);
console.log(seen.size);
seen.forEach((node) => {
  if (node === undefined) console.log("undefined");
  else if (node instanceof Branch) console.log("branch", node.name, node.children.length);
  else console.log("leaf", node.name);
});

// Records, arrays and functions, or undefined.
type Point = { x: number; y: number };
const origin: Point = { x: 0, y: 0 };
const points = new Map<Point | undefined, string>([
  [origin, "origin"],
  [undefined, "none"],
  [{ x: 0, y: 0 }, "copy"],
]);
console.log(points.size, points.get(origin), points.get(undefined), points.get({ x: 0, y: 0 }));

const row = [1, 2, 3];
const rows = new Set<number[] | undefined>([row, undefined, [1, 2, 3], row]);
console.log(rows.size, rows.has(row), rows.has([1, 2, 3]));

const greet = (): string => "hi";
const handlers = new Map<(() => string) | undefined, number>();
handlers.set(greet, 1);
handlers.set(undefined, 2);
handlers.set(greet, 3);
console.log(handlers.size, handlers.get(greet), handlers.get(undefined));

// Strings compare by value, beside undefined.
const names = new Map<string | undefined, number>([
  ["a", 1],
  [undefined, 2],
]);
names.set(["a"].join(""), 3);
console.log(names.size, names.get("a"), names.get(undefined));

// The values keep their identity through the collection.
const copied = new Set<Leaf | undefined>(leaves);
console.log([...copied][0] === a, copied.has(b), copied.size);
