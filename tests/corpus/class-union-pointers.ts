// Unions of two or more classes hold the instance pointer itself: wraps,
// narrowing by instanceof and by a discriminant field, unit arms, identity,
// containers, fields, retypes between such unions, captures, and the
// conversions that print or serialize a union value.
class Circle {
  readonly kind = "circle";
  readonly r: number;
  constructor(r: number) {
    this.r = r;
  }
  area(): number {
    return 3 * this.r * this.r;
  }
}

class Rect {
  readonly kind = "rect";
  readonly w: number;
  readonly h: number;
  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
  }
  area(): number {
    return this.w * this.h;
  }
}

class Tri {
  readonly kind = "tri";
  readonly b: number;
  readonly h: number;
  constructor(b: number, h: number) {
    this.b = b;
    this.h = h;
  }
}

type Shape = Circle | Rect | Tri;
type MaybeShape = Shape | undefined;
type NullableShape = Circle | Rect | null | undefined;

function area(s: Shape): number {
  if (s instanceof Circle) return s.area();
  if (s instanceof Rect) return s.area();
  return (s.b * s.h) / 2;
}

function byKind(s: Shape): string {
  switch (s.kind) {
    case "circle":
      return `circle ${s.r}`;
    case "rect":
      return `rect ${s.w}x${s.h}`;
    case "tri":
      return `tri ${s.b}/${s.h}`;
  }
}

function make(i: number): Shape {
  if (i % 3 === 0) return new Circle(i);
  if (i % 3 === 1) return new Rect(i, i + 1);
  return new Tri(i, 2);
}

const shapes: Shape[] = [];
for (let i = 0; i < 9; i++) shapes.push(make(i));
console.log(shapes.map(area).join(" "));
console.log(shapes.map(byKind).join(", "));

// Unit arms: undefined is NULL, null is a sentinel when both are present.
function describe(s: MaybeShape): string {
  if (s === undefined) return "none";
  return byKind(s);
}
function describeNullable(s: NullableShape): string {
  if (s === null) return "null";
  if (s === undefined) return "undefined";
  return s instanceof Circle ? `c${s.r}` : `r${s.w}`;
}
const maybe: MaybeShape[] = [undefined, new Circle(2), undefined, new Tri(1, 1)];
console.log(maybe.map(describe).join(" "));
const nullable: NullableShape[] = [null, new Rect(3, 4), undefined, new Circle(5)];
console.log(nullable.map(describeNullable).join(" "));
console.log(nullable.map((s) => s ?? "fallback").map((s) => (typeof s === "string" ? s : s.kind)).join(" "));
console.log(maybe.map((s) => s?.kind ?? "-").join(" "));

// Identity: equality compares instances.
const c = new Circle(1);
const a: Shape = c;
const b: Shape = c;
const other: Shape = new Circle(1);
console.log(a === b, a === other, a !== other, shapes.indexOf(shapes[4]!), shapes.includes(other));

// Fields of class-union type, reassigned and cleared.
class Slot {
  current: MaybeShape = undefined;
  history: Shape[] = [];
  put(s: Shape): void {
    if (this.current !== undefined) this.history.push(this.current);
    this.current = s;
  }
}
const slot = new Slot();
for (const s of shapes.slice(0, 5)) slot.put(s);
console.log(describe(slot.current), slot.history.length, slot.history.map((s) => s.kind).join(","));
slot.current = undefined;
console.log(describe(slot.current));

// Maps and sets of instances, keyed by an arm-independent value.
const byName = new Map<string, Shape>();
for (const s of shapes) byName.set(byKind(s), s);
let total = 0;
for (const [, s] of byName) total += area(s);
console.log(byName.size, total);
const seen = new Set<Circle>();
for (const s of shapes) if (s instanceof Circle) seen.add(s);
console.log(seen.size);

// Retypes: a narrower union widens to a wider one and back.
type Round = Circle | Rect;
function widen(r: Round): MaybeShape {
  return r;
}
function narrow(s: MaybeShape): Round | undefined {
  if (s === undefined || s instanceof Tri) return undefined;
  return s;
}
const round: Round[] = [new Circle(7), new Rect(1, 2)];
console.log(round.map(widen).map(describe).join(" "), describe(narrow(new Tri(3, 3))), describe(narrow(round[1])));

// Captures and callbacks.
function counter(start: Shape): () => string {
  let s: Shape = start;
  let n = 0;
  return () => {
    n++;
    s = n % 2 === 0 ? new Rect(n, n) : new Circle(n);
    return byKind(s);
  };
}
const next = counter(new Tri(0, 0));
console.log(next(), next(), next());
console.log(shapes.filter((s) => s instanceof Rect).length, shapes.find((s) => s instanceof Tri)?.kind);
console.log([...shapes].sort((x, y) => area(x) - area(y)).map((s) => area(s)).join(" "));

// Printing and serializing union values.
console.log(shapes[0], shapes[1], shapes[2]);
console.log(JSON.stringify(shapes.slice(0, 3)));
console.log(JSON.stringify({ current: slot.history[0], none: maybe[0] }));
console.log(String(shapes[3] instanceof Circle), `${shapes[4] instanceof Rect}`);
const mixed: (Shape | number)[] = [new Circle(1), 4];
console.log(mixed.map((m) => (typeof m === "number" ? m : m.kind)).join(" "));

// Fresh instances passed straight to functions that only read them.
function width(s: Shape): number {
  return s instanceof Rect ? s.w : s instanceof Circle ? s.r * 2 : s.b;
}
let widths = 0;
for (let i = 0; i < 100; i++) widths += width(new Rect(i, 1)) + width(new Circle(i)) + width(new Tri(1, i));
console.log(widths, byKind(new Rect(2, 3)), width(new Circle(4)));

// Conversions between class unions, boxed unions and unknown values.
function boxed(s: Shape): Shape | number | string {
  return s;
}
function unboxed(v: Shape | number | string): Shape | undefined {
  return typeof v === "number" || typeof v === "string" ? undefined : v;
}
const wide = shapes.slice(0, 3).map(boxed);
wide.push(5, "text");
console.log(wide.map((v) => (typeof v === "object" ? v.kind : typeof v)).join(" "));
console.log(wide.map(unboxed).map(describe).join(" "));
const anyValues: unknown[] = shapes.slice(3, 6);
console.log(anyValues.map((v) => (v instanceof Circle ? "C" : v instanceof Rect ? "R" : v instanceof Tri ? "T" : "?")).join(""));
const back = anyValues[1] as Shape;
console.log(byKind(back), (anyValues[0] as Circle).r, JSON.stringify(anyValues));
try {
  console.log((anyValues[2] as Circle).area());
} catch (e) {
  console.log((e as Error).name);
}
