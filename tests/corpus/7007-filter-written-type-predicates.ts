// `.filter` with a written type predicate: an annotated callback
// (`(p): p is Cat => ...`) or a guard function passed as a value. The
// result holds the predicate's type: a union arm, a union of arms, a
// number out of `unknown`, a record or tuple with a narrower field, or a
// subclass. An inferred predicate that keeps several arms narrows too.
interface Cat {
  kind: "cat";
  meow: string;
}
interface Dog {
  kind: "dog";
  bark: number;
}
interface Fish {
  kind: "fish";
  fins: number;
}
type Pet = Cat | Dog | Fish;
const pets: Pet[] = [
  { kind: "cat", meow: "m" },
  { kind: "dog", bark: 2 },
  { kind: "fish", fins: 3 },
  { kind: "dog", bark: 5 },
];

const cats = pets.filter((p): p is Cat => p.kind === "cat");
console.log(cats.length, cats[0]!.meow);
const furry = pets.filter((p): p is Cat | Dog => p.kind !== "fish");
console.log(furry.map((p) => (p.kind === "cat" ? p.meow : p.bark)).join(","));
const notFish = pets.filter((p) => p.kind !== "fish");
console.log(notFish.length);

function isDog(p: Pet): p is Dog {
  return p.kind === "dog";
}
console.log(pets.filter(isDog).map((d) => d.bark * 10).join(","));

const isNumber = (v: unknown): v is number => typeof v === "number";
const values: unknown[] = JSON.parse('[1, "a", 2, null, 4]');
console.log(values.filter(isNumber).reduce((sum, n) => sum + n, 0));

const rows: unknown[] = JSON.parse('[{"id":1},{"id":"x"},{"id":3}]');
const withIds = rows.filter(
  (r): r is { id: number } => typeof (r as { id: unknown }).id === "number",
);
console.log(withIds.map((r) => r.id + 1).join(","));

const entries: [string, unknown][] = [
  ["a", 1],
  ["b", "x"],
  ["c", 3],
];
const numeric = entries.filter((e): e is [string, number] => typeof e[1] === "number");
console.log(numeric.map(([key, value]) => `${key}${value * 2}`).join(" "));

class Shape {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
}
class Circle extends Shape {
  r: number;
  constructor(r: number) {
    super("circle");
    this.r = r;
  }
}
const shapes: Shape[] = [new Shape("square"), new Circle(2), new Circle(3)];
const circles = shapes.filter((s): s is Circle => s instanceof Circle);
console.log(circles.length, circles.map((c) => c.r).join("+"));

const mixed: (string | number | boolean)[] = ["a", 1, true, "b"];
console.log(mixed.filter((v): v is string => typeof v === "string").join(""));
console.log(mixed.filter((v): v is string | number => typeof v !== "boolean").length);

const pair: [string | number, string | number] = ["x", 4];
console.log(pair.filter((v): v is number => typeof v === "number").map((n) => n + 1).join());

const optional: (string | number | undefined)[] = ["a", 1, undefined, 2];
const defined = optional.filter((v) => v !== undefined);
console.log(defined.length, defined.map((v) => typeof v).join(","));
function isText(v: string | undefined): v is string {
  return typeof v === "string";
}
const maybe: (string | undefined)[] = ["a", undefined, "b"];
console.log(maybe.filter(isText).join("-"));

// Narrowing a record field keeps each object's own keys, in its own order,
// and an optional field the object lacks stays absent.
interface Row {
  id: unknown;
  note?: string;
  label: string;
}
interface NumericRow {
  id: number;
  note?: string;
  label: string;
}
const tableRows: Row[] = [
  { label: "a", id: 1 },
  { label: "b", id: "s" },
  { label: "c", id: 3, note: "n" },
];
for (const row of tableRows.filter((r): r is NumericRow => typeof r.id === "number")) {
  console.log(Object.keys(row).join(","), JSON.stringify(row), "note" in row, row.id + 1);
}
