// What a generic function builds from an array with holes, read by code
// with a concrete element type: a map into another element type keeps the
// holes, a spread or a rest pattern turns them into present undefined
// elements, a push moves them into another array.
interface Part {
  id: string;
}

function mapAll<T, U>(xs: T[], f: (v: T) => U): U[] {
  return xs.map(f);
}

function clone<T>(xs: readonly T[]): T[] {
  return [...xs];
}

function sliced<T>(xs: readonly T[]): T[] {
  return xs.slice();
}

// The array sits in a field of the argument and of the result.
function idsOf<T, U>(box: { items: T[] }, f: (v: T) => U): U[] {
  return box.items.map(f);
}

function split<T>(xs: readonly T[]): { head: T[]; tail: T[] } {
  return { head: xs.slice(0, 1), tail: [...xs.slice(1)] };
}

function gather<T>(xs: readonly T[], into: T[]): T[] {
  into.push(...xs);
  const [, ...rest] = xs;
  return rest;
}

class Bin<T> {
  items: T[];
  constructor(items: T[]) {
    this.items = items;
  }
  copy(): T[] {
    return [...this.items];
  }
  mapped<U>(f: (v: T) => U): U[] {
    return this.items.map(f);
  }
}

const show = (p: Part): string => p.id;

function loop(parts: Part[]): string {
  const out: string[] = [];
  for (const p of parts) out.push(p === undefined ? "-" : show(p));
  return out.join(",");
}

function visit(parts: Part[]): string {
  const out: string[] = [];
  parts.forEach((p) => out.push(p === undefined ? "-" : show(p)));
  return out.join(",");
}

function mapped(parts: Part[]): string {
  return parts.map((p) => (p === undefined ? "-" : show(p))).join("|");
}

function firstMissing(parts: Part[]): number {
  return parts.findIndex((p) => p === undefined);
}

const parts: Part[] = [];
parts[2] = { id: "c" };

const copy = clone(parts);
console.log(copy.length, 0 in copy, loop(copy), visit(copy), mapped(copy), firstMissing(copy));

const cut = sliced(parts);
console.log(cut.length, 0 in cut, loop(cut), visit(cut), mapped(cut), firstMissing(cut));

const names: string[] = mapAll(parts, (p) => p.id);
const seen: string[] = [];
for (const name of names) seen.push(name === undefined ? "-" : name.toUpperCase());
console.log(names.length, 0 in names, seen.join(","));
names.forEach((name) => seen.push(name.toUpperCase()));
console.log(seen.join(","));

const sink: Part[] = [];
const rest = gather(parts, sink);
console.log(sink.length, 0 in sink, loop(sink), visit(sink));
console.log(rest.length, 0 in rest, loop(rest), visit(rest));

const bin = new Bin(parts);
const binCopy = bin.copy();
console.log(binCopy.length, loop(binCopy), visit(binCopy));
const ids = bin.mapped((p) => p.id);
const listed: string[] = [];
for (const id of ids) listed.push(id === undefined ? "-" : id);
console.log(ids.length, listed.join(","));

const boxed: string[] = idsOf({ items: parts }, (p) => p.id);
const fromBox: string[] = [];
for (const id of boxed) fromBox.push(id === undefined ? "-" : id);
console.log(boxed.length, 0 in boxed, fromBox.join(","));
const halves = split(parts);
console.log(halves.head.length, 0 in halves.head, loop(halves.head), visit(halves.head));
console.log(halves.tail.length, 0 in halves.tail, loop(halves.tail), visit(halves.tail));

// Dense arrays through the same functions.
const dense: Part[] = [{ id: "x" }, { id: "y" }];
console.log(loop(clone(dense)), visit(sliced(dense)), mapAll(dense, show).join(","));
console.log(visit(new Bin(dense).copy()), new Bin(dense).mapped(show).join(","));
console.log(idsOf({ items: dense }, show).join(","), visit(split(dense).tail));
