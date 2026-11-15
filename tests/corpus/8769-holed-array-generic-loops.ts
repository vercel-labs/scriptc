// An array with holes passed into generic code. A for-of loop in a generic
// function, method or class binds undefined for each hole, as the same loop
// over a concrete element type does: a guard sees it, and a member read of
// it throws a TypeError the caller can catch.
interface Crate {
  id: string;
  weight: number;
}

const crate = (id: string, weight: number): Crate => ({ id, weight });
const label = (c: Crate): string => `${c.id}:${c.weight}`;

function each<T>(xs: T[], show: (v: T) => string): string {
  const out: string[] = [];
  for (const x of xs) out.push(x === undefined ? "-" : show(x));
  return out.join(",");
}

function eachReadonly<T>(xs: readonly T[], show: (v: T) => string): string {
  const out: string[] = [];
  for (const x of xs) out.push(x === undefined ? "-" : show(x));
  return out.join(",");
}

function eachConstrained<T extends Crate>(xs: readonly T[]): string {
  const out: string[] = [];
  for (const x of xs) out.push(x === undefined ? "-" : x.id);
  return out.join(",");
}

// The type parameter is the array type itself.
function eachOf<A extends readonly Crate[]>(xs: A): string {
  const out: string[] = [];
  for (const x of xs) out.push(x === undefined ? "-" : x.id);
  return out.join(",");
}

function merged<T>(base: readonly T[], extra: readonly T[], show: (v: T) => string): string {
  const out: string[] = [];
  for (const x of [...base, ...extra]) out.push(x === undefined ? "-" : show(x));
  return out.join(",");
}

function viaValues<T>(xs: T[], show: (v: T) => string): string {
  const out: string[] = [];
  for (const x of xs.values()) out.push(x === undefined ? "-" : show(x));
  return out.join(",");
}

function viaCopies<T>(xs: readonly T[], show: (v: T) => string): string {
  const out: string[] = [];
  for (const x of xs.slice()) out.push(x === undefined ? "-" : show(x));
  for (const x of xs.concat(xs)) out.push(x === undefined ? "-" : show(x));
  const copy = [...xs];
  for (const x of copy) out.push(x === undefined ? "-" : show(x));
  const kept = xs.slice();
  for (const x of kept) out.push(x === undefined ? "-" : show(x));
  const backwards = xs.slice().reverse();
  for (const x of backwards) out.push(x === undefined ? "-" : show(x));
  return out.join(",");
}

// A generic function that hands its parameter to another one.
function outer<T>(xs: T[], show: (v: T) => string): string {
  return eachReadonly(xs, show);
}

function fromRecord<T>(box: { items: T[] }, show: (v: T) => string): string {
  const out: string[] = [];
  for (const x of box.items) out.push(x === undefined ? "-" : show(x));
  return out.join(",");
}

class Shelf<T> {
  items: T[];
  constructor(items: T[]) {
    this.items = items;
  }
  list(show: (v: T) => string): string {
    const out: string[] = [];
    for (const x of this.items) out.push(x === undefined ? "-" : show(x));
    return out.join(",");
  }
}

class Tool {
  list<T>(xs: T[], show: (v: T) => string): string {
    const out: string[] = [];
    for (const x of xs) out.push(x === undefined ? "-" : show(x));
    return out.join(",");
  }
}

// The loop reads a member without a guard: Node throws at the hole.
function unguarded<T extends Crate>(xs: readonly T[]): string {
  const out: string[] = [];
  for (const x of xs) out.push(x.id);
  return out.join(",");
}

function attempt(what: string, run: () => string): void {
  try {
    console.log(what, run());
  } catch (e) {
    console.log(what, "threw", e instanceof TypeError);
  }
}

// Each way of making a hole.
const written: Crate[] = [];
written[2] = crate("w", 2);
const sized: Crate[] = Array(3);
sized[1] = crate("s", 1);
const constructed: Crate[] = new Array(3);
constructed[0] = crate("n", 0);
const elided = [, crate("e", 1), ,] as Crate[];
const grown: Crate[] = [crate("g", 0)];
grown.length = 3;
const dense: Crate[] = [crate("a", 1), crate("b", 2)];

const sources: [string, Crate[]][] = [
  ["written", written],
  ["sized", sized],
  ["constructed", constructed],
  ["elided", elided],
  ["grown", grown],
  ["dense", dense],
];
for (const [name, crates] of sources) {
  attempt(`${name} each`, () => each(crates, label));
  attempt(`${name} readonly`, () => eachReadonly(crates, label));
  attempt(`${name} constrained`, () => eachConstrained(crates));
  attempt(`${name} array type`, () => eachOf(crates));
  attempt(`${name} merged`, () => merged(crates, dense, label));
  attempt(`${name} values`, () => viaValues(crates, label));
  attempt(`${name} copies`, () => viaCopies(crates, label));
  attempt(`${name} outer`, () => outer(crates, label));
  attempt(`${name} record`, () => fromRecord({ items: crates }, label));
  attempt(`${name} class`, () => new Shelf(crates).list(label));
  attempt(`${name} method`, () => new Tool().list(crates, label));
  attempt(`${name} unguarded`, () => unguarded(crates));
}

// Other element types take the same path.
const words: string[] = [];
words[2] = "c";
attempt("words", () => each(words, (w) => w.toUpperCase()));
attempt("words merged", () => merged(words, ["d"], (w) => w.toUpperCase()));
const counts: number[] = [1];
counts.length = 3;
attempt("counts", () => each(counts, (n) => String(n * 2)));
attempt("counts copies", () => viaCopies(counts, (n) => String(n * 2)));
