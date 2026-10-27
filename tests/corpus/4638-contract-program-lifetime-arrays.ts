import type { ProgramLifetime } from "@scriptc/types";

// Arrays of ProgramLifetime class instances: literals, growth, removal
// from both ends, splicing, slicing, concatenation, searching, sorting,
// filling, copying methods, holes, length changes, Sets and Maps built
// from them, arrays held in class fields, optional elements, inspection
// and JSON. Each operation sees the same instances, in the same order.

class Sym implements ProgramLifetime {
  readonly name: string;
  readonly rank: number;
  readonly decls: Sym[] = [];
  parent: Sym | undefined = undefined;
  constructor(name: string, rank: number) {
    this.name = name;
    this.rank = rank;
  }
}

class Scope implements ProgramLifetime {
  readonly symbols: Sym[] = [];
  readonly optional: (Sym | undefined)[] = [];
  readonly nullable: (Sym | null)[] = [];
}

const names = (xs: readonly (Sym | undefined | null)[]): string =>
  xs.map((s) => (s === undefined ? "u" : s === null ? "n" : s.name)).join(",");

const a = new Sym("a", 3);
const b = new Sym("b", 1);
const c = new Sym("c", 2);
const d = new Sym("d", 5);
const e = new Sym("e", 4);

// Literals, push, pop, shift and unshift.
const xs: Sym[] = [a, b, c];
xs.push(d);
xs.push(e, a);
console.log(names(xs), xs.length);
console.log(xs.pop()?.name, xs.shift()?.name, names(xs));
xs.unshift(e, d);
console.log(names(xs), xs[0] === e, xs.at(-1) === e);

// Growth well past the inline slots, then reads by index.
const many: Sym[] = [];
for (let i = 0; i < 1000; i++) many.push(i % 2 === 0 ? a : new Sym(`s${i}`, i));
let ranks = 0;
for (let i = 0; i < many.length; i++) ranks += many[i]!.rank;
console.log(many.length, ranks, many[999]!.name, many[998] === a);

// Splice, slice, concat, spread and copying methods.
const ys = xs.slice(1, 4);
const removed = xs.splice(1, 2, a, b, c);
console.log(names(ys), names(removed), names(xs));
const zs = [...ys, ...removed].concat(xs);
console.log(names(zs), zs.length);
console.log(names(zs.toReversed()), names(zs.with(0, c)), names(zs.toSpliced(1, 3)));

// Searching by identity.
console.log(zs.indexOf(c), zs.lastIndexOf(c), zs.includes(d), zs.indexOf(new Sym("c", 2)));
console.log(zs.find((s) => s.rank > 3)?.name, zs.findIndex((s) => s === b), zs.some((s) => s === e));
console.log(zs.every((s) => s.rank > 0), zs.filter((s) => s.rank % 2 === 1).length);

// Sorting with comparators, reversing and filling.
const sorted = [...zs].sort((p, q) => p.rank - q.rank || p.name.localeCompare(q.name));
console.log(names(sorted));
console.log(names(zs.toSorted((p, q) => q.name.localeCompare(p.name))));
sorted.reverse();
console.log(names(sorted));
const filled: Sym[] = new Array<Sym>(5).fill(b);
filled.fill(c, 2, 4);
console.log(names(filled), filled.copyWithin(0, 3).map((s) => s.name).join(""));

// Holes, length changes and iteration.
const holey: Sym[] = [a, b];
holey[5] = c;
console.log(holey.length, 2 in holey, holey[5]?.name, holey.findIndex((s) => s === c));
holey.length = 3;
console.log(holey.length, holey[5]);
let visited = "";
for (const s of xs) visited += s.name;
xs.forEach((s, i) => {
  visited += i;
});
console.log(visited, names(xs.map((s) => s.parent ?? s)));

// Arrays inside class instances, optional and nullable elements.
const scope = new Scope();
for (const s of [a, b, c, d, e]) {
  scope.symbols.push(s);
  s.decls.push(s, a);
  s.parent = scope.symbols[0];
}
scope.optional.push(a, undefined, c);
scope.nullable.push(null, b, null);
scope.optional[3] = e;
console.log(names(scope.symbols), names(scope.optional), names(scope.nullable));
console.log(scope.optional.indexOf(undefined), scope.nullable.indexOf(null), scope.optional.length);
console.log(c.decls.length, c.decls[1] === a, e.parent === a, names(e.decls));

// Sets and Maps built from arrays, and arrays built from them.
const set = new Set(zs);
console.log(set.size, set.has(d), names([...set]));
const byName = new Map(zs.map((s) => [s.name, s] as const));
console.log(names([...byName.values()]), byName.get("b") === b);
const grouped = new Map<number, Sym[]>();
for (const s of many.slice(0, 10)) {
  const list = grouped.get(s.rank % 3) ?? [];
  list.push(s);
  grouped.set(s.rank % 3, list);
}
console.log([...grouped.entries()].map(([k, v]) => `${k}:${v.length}`).join(" "));

// Inspection and JSON.
console.log(xs.slice(0, 2).map((s) => s.name));
console.log(JSON.stringify(scope.nullable.map((s) => s?.rank ?? null)));
console.log(JSON.stringify([a, b].map((s) => ({ name: s.name, rank: s.rank }))));
