// Records and class instances passed to `T | undefined` and `T | null`
// parameters. The callee receives the object pointer itself, so a binding
// that the callee only reads keeps its frame storage; callees that keep,
// return or compare the argument still see one shared object.
interface Vec {
  x: number;
  y: number;
}
interface Tagged {
  name: string;
  at: Vec;
}
function vec(x: number, y: number): Vec {
  return { x, y };
}
function len(v: Vec | undefined): number {
  return v === undefined ? -1 : Math.sqrt(v.x * v.x + v.y * v.y);
}
function sum(a: Vec | undefined, b: Vec): Vec {
  return a === undefined ? b : { x: a.x + b.x, y: a.y + b.y };
}
function label(t: Tagged | undefined): string {
  return t === undefined ? "none" : t.name + "@" + t.at.x + "," + t.at.y;
}
function depth(v: Vec | undefined, n: number): number {
  if (v === undefined || n === 0) return 0;
  return v.x + depth(v, n - 1);
}

const kept: (Vec | undefined)[] = [];
function keep(v: Vec | undefined): number {
  kept.push(v);
  return kept.length;
}
function same(a: Vec | undefined, b: Vec): boolean {
  return a === b;
}
function orNull(v: Vec | undefined): Vec | undefined {
  return v !== undefined && v.x < 0 ? undefined : v;
}

class Cell {
  value: number;
  next: Cell | null;
  constructor(value: number, next: Cell | null) {
    this.value = value;
    this.next = next;
  }
}
function cellTotal(c: Cell | null): number {
  let total = 0;
  for (let at = c; at !== null; at = at.next) total += at.value;
  return total;
}
function fail(v: Vec | undefined): number {
  if (v !== undefined && v.x > 100) throw new Error("too far: " + v.x);
  return v === undefined ? 0 : v.x;
}

function projections(): void {
  const a = vec(3, 4);
  const b = sum(a, vec(1, 1));
  console.log("len", len(a), len(b), len(undefined));
  const c = sum(sum(a, b), a);
  console.log("sum", c.x, c.y, sum(undefined, a).x);
  console.log("depth", depth(a, 5), depth(undefined, 3));
  let total = 0;
  for (let i = 0; i < 1000; i++) {
    const p = vec(i, i + 1);
    total += len(p) + len(sum(p, a));
  }
  console.log("loop", total.toFixed(6));
}

function mutated(): void {
  const p = vec(1, 2);
  console.log("before", len(p));
  p.x = 6;
  p.y = 8;
  console.log("after", len(p));
}

function strings(): void {
  const prefix = ["a", "b", "c"].join("-");
  const t: Tagged = { name: prefix + "!", at: vec(2, 5) };
  console.log("label", label(t), label(undefined));
  const u: Tagged = { name: label(t), at: t.at };
  console.log("nested", label(u));
}

function escapes(): void {
  const a = vec(7, 8);
  const count = keep(a);
  const b = vec(9, 10);
  console.log("kept", count, kept[0] === a, kept[0]!.x, keep(b), kept[1]!.y);
  a.x = 70;
  console.log("shared", kept[0]!.x);
  const c = vec(1, 1);
  console.log("same", same(c, c), same(c, vec(1, 1)), same(undefined, c));
  const d = vec(-1, 2);
  const e = vec(4, 5);
  console.log("returned", orNull(d), orNull(e) === e, orNull(e)!.y);
}

function classes(): void {
  const tail = new Cell(3, null);
  const list = new Cell(1, new Cell(2, tail));
  console.log("cells", cellTotal(list), cellTotal(tail), cellTotal(null));
}

function throwing(): void {
  const near = vec(5, 0);
  const far = vec(500, 0);
  try {
    console.log("near", fail(near));
    console.log("far", fail(far));
  } catch (e) {
    console.log("caught", (e as Error).message, near.x, far.x);
  }
}

projections();
mutated();
strings();
escapes();
classes();
throwing();
