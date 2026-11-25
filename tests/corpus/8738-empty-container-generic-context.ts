// A fresh empty container passed through a generic call takes its element
// type from the call's destination. tsc infers the type argument from the
// argument first (`[]` is `never[]`, `new Map()` is `Map<any, any>`), so
// the declared type on the left has to reach the instance another way.
function id<T>(v: T): T {
  return v;
}
function viaUnknown<T>(v: T): T {
  const u: unknown = v;
  return u as T;
}
function boxed<T>(v: T): T {
  const b = { v };
  return b.v;
}
function both<A, B>(a: A, b: B): { a: A; b: B } {
  return { a, b };
}
function listOf<T>(seed: T[], extra: T): T[] {
  seed.push(extra);
  return seed;
}

interface Point {
  x: number;
  y: number;
}

// A declaration.
const names: string[] = id([]);
names.push("ada", "grace");
console.log(names, names.length);

// A record element.
const points: Point[] = id([]);
points.push({ x: 1, y: 2 });
console.log(points);

// Through `unknown` and through a field.
const flags: boolean[] = viaUnknown([]);
flags.push(true, false);
const counts: number[] = boxed([]);
counts.push(3, 4);
console.log(flags, counts);

// A typed argument and a return.
function total(values: number[]): number {
  values.push(40, 2);
  let sum = 0;
  for (const value of values) sum += value;
  return sum;
}
function fresh(): Point[] {
  return id([]);
}
const made = fresh();
made.push({ x: 5, y: 6 });
console.log(total(id([])), made);

// A later assignment and an optional destination.
let later: string[];
later = id([]);
later.push("z");
const maybe: string[] | undefined = id([]);
console.log(later, maybe, maybe === undefined ? -1 : maybe.length);

// A field of a typed literal.
const holder: { items: string[]; ids: number[] } = { items: id([]), ids: id([]) };
holder.items.push("item");
holder.ids.push(7);
console.log(holder);

// Two type parameters, each from its own empty argument.
const pair: { a: string[]; b: number[] } = both([], []);
pair.a.push("left");
pair.b.push(9);
console.log(pair);

// The destination's element type is already the inferred one.
const plain: number[] = id([]);
plain.push(1);
const seeded = listOf([], "s");
console.log(plain, seeded);

// Maps and sets.
const ages: Map<string, number> = id(new Map());
ages.set("ada", 36);
const seen: Set<string> = id(new Set());
seen.add("x");
function tally(m: Map<string, number[]>): number {
  m.set("k", [1, 2, 3]);
  return m.get("k")!.length;
}
console.log(ages, seen, tally(id(new Map())));

// The array a generic call returns is the one it was given.
const kept: string[][] = [];
function remember<T>(v: T, into: T[]): T {
  into.push(v);
  return v;
}
const first: string[] = remember([], kept);
first.push("shared");
console.log(kept, kept[0] === first);

// An empty container beside an element that can be missing: each type
// parameter takes its own binding in the one instance the call names.
const noticed: boolean[] = [];
function noting<A, B>(a: A, b: B): A {
  noticed.push(b === undefined);
  return a;
}
const lookups: number[] = [1, 2];
const noted: string[] = noting([], lookups[20]);
noted.push("n");
const inRange: string[] = noting([], lookups[1]);
console.log(noted, inRange, noticed);
