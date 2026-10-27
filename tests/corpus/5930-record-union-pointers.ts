// Unions whose arms are all object literals (discriminated unions) hold the
// record itself: construction, narrowing, storage in arrays, maps, fields
// and closures, identity, and printing behave exactly as in Node.
type Shape =
  | { kind: "circle"; r: number }
  | { kind: "rect"; w: number; h: number }
  | { kind: "tri"; b: number; h: number; label: string };

function area(s: Shape): number {
  switch (s.kind) {
    case "circle":
      return Math.round(3.14159 * s.r * s.r);
    case "rect":
      return s.w * s.h;
    case "tri":
      return 0.5 * s.b * s.h;
  }
}

function make(i: number): Shape {
  if (i % 3 === 0) return { kind: "circle", r: i };
  if (i % 3 === 1) return { kind: "rect", w: i, h: i + 1 };
  return { kind: "tri", b: i, h: 2, label: "t" + i };
}

const shapes: Shape[] = [];
for (let i = 0; i < 9; i++) shapes.push(make(i));
let total = 0;
for (const s of shapes) total += area(s);
console.log("total", total);
console.log(shapes.map((s) => s.kind).join(","));
console.log(shapes.filter((s) => s.kind === "rect").length);

// Identity: the same record compares equal, a structurally equal one does not.
const first = shapes[0]!;
const again: Shape = shapes[0]!;
const copy: Shape = { kind: "circle", r: 0 };
console.log(first === again, first === copy, shapes.indexOf(again), shapes.includes(copy));

// Mutation through one alias is visible through the union value.
const rect = { kind: "rect" as const, w: 2, h: 3 };
const asShape: Shape = rect;
rect.w = 10;
console.log(area(asShape), asShape === rect);

// Fields, maps and closures holding union values.
interface Holder {
  current: Shape;
  history: Shape[];
}
const holder: Holder = { current: make(1), history: [] };
for (let i = 0; i < 4; i++) {
  holder.history.push(holder.current);
  holder.current = make(i + 5);
}
console.log(holder.current.kind, holder.history.map(area).join(" "));

const byName = new Map<string, Shape>();
for (const s of shapes) byName.set(s.kind + area(s), s);
console.log(byName.size, byName.get("rect2")?.kind, byName.get("missing") === undefined);

const pick = (k: Shape["kind"]): (() => Shape | undefined) => {
  const found = shapes.find((s) => s.kind === k);
  return () => found;
};
const getTri = pick("tri");
const tri = getTri();
console.log(tri !== undefined && tri.kind === "tri" ? tri.label : "none");

// Printing and serialization see the plain objects.
console.log(shapes.slice(0, 3));
console.log(JSON.stringify(shapes.slice(0, 3)));
const second = shapes[2]!;
console.log(`${String(shapes[1]!.kind)} ${"label" in second} ${"label" in shapes[1]!}`);

// Spread copies and sorting.
const grown = shapes.map((s): Shape => (s.kind === "circle" ? { ...s, r: s.r + 1 } : s));
grown.sort((a, b) => area(a) - area(b));
console.log(grown.map((s) => `${s.kind}:${area(s)}`).join(" "));
