// Arrays a generic function builds from an array with holes, read by
// callbacks an array loop takes into its own body (the callback is then no
// function of the program any more), by the same callbacks kept as function
// values, and by index into nested functions and generic instances. A copy
// made by a spread holds each hole as a present undefined and every reader
// sees it; a copy made by slice keeps the holes and the callbacks skip them.
interface Part {
  id: string;
  n: number;
}

function clone<T>(xs: readonly T[]): T[] {
  return [...xs];
}

function sliced<T>(xs: readonly T[]): T[] {
  return xs.slice();
}

function mapAll<T, U>(xs: T[], f: (v: T) => U): U[] {
  return xs.map(f);
}

const parts: Part[] = [];
parts[1] = { id: "b", n: 2 };
parts[3] = { id: "d", n: 4 };

const copy = clone(parts);
const cut = sliced(parts);
const dense = clone<Part>([
  { id: "x", n: 1 },
  { id: "y", n: 5 },
]);

// A callback written at the call, once per method.
function inline(label: string, xs: Part[]): void {
  let total = 0;
  xs.forEach((p) => {
    total += p === undefined ? 100 : p.n;
  });
  const ids = xs.map((p) => (p === undefined ? "-" : p.id));
  const missing = xs.filter((p): boolean => p === undefined).length;
  const present = xs.filter((p): boolean => p !== undefined).length;
  const sum = xs.reduce((acc, p) => acc + (p === undefined ? 1000 : p.n), 0);
  const some = xs.some((p) => p === undefined);
  const every = xs.every((p) => p !== undefined);
  const found = xs.find((p) => p !== undefined && p.n > 2);
  const at = xs.findIndex((p) => p === undefined);
  const flat = xs.flatMap((p) => (p === undefined ? ["-", "-"] : [p.id]));
  console.log(
    label,
    xs.length,
    total,
    ids.length,
    ids.join(","),
    missing,
    present,
    sum,
    some,
    every,
    found === undefined ? "none" : found.id,
    at,
    flat.join(""),
  );
}
inline("inline copy", copy);
inline("inline cut", cut);
inline("inline dense", dense);

// Chains of callbacks over one array.
function chained(label: string, xs: Part[]): void {
  const big = xs
    .map((p) => (p === undefined ? 0 : p.n))
    .filter((n): boolean => n !== 2)
    .map((n) => n * 10);
  const names = xs
    .filter((p): boolean => p === undefined || p.n > 1)
    .map((p) => (p === undefined ? "?" : p.id.toUpperCase()));
  const weight = xs.map((p) => (p === undefined ? 7 : p.n)).reduce((a, b) => a + b, 0);
  console.log(label, big.join(","), names.join(","), weight);
}
chained("chained copy", copy);
chained("chained cut", cut);
chained("chained dense", dense);

// The same callback as a value: passed by name, twice.
const label = (p: Part): string => (p === undefined ? "-" : p.id);
const heavy = (p: Part): boolean => p !== undefined && p.n > 2;
console.log("value copy", copy.map(label).join(","), copy.filter(heavy).map(label).join(","));
console.log("value cut", cut.map(label).join(","), cut.filter(heavy).map(label).join(","));
console.log("value dense", dense.map(label).join(","), dense.filter(heavy).map(label).join(","));

// An element read by index and passed to a nested function, to the same
// function as a typed value, and to generic instances.
function id<T>(v: T): T {
  return v;
}
function orElse<T>(v: T, fallback: T): T {
  return v === undefined ? fallback : v;
}
function isMissing<T>(v: T): boolean {
  return v === undefined;
}
function indexed(xs: Part[]): string {
  function note(p: Part): string {
    return p === undefined ? "-" : p.id;
  }
  const typed: (p: Part) => string = note;
  return note(xs[0]) + note(xs[1]) + note(xs[9]) + typed(xs[0]);
}
const fallback: Part = { id: "f", n: 0 };
console.log(
  "indexed",
  indexed(copy),
  indexed(cut),
  indexed(dense),
  id(copy[0]) === undefined,
  orElse(copy[0], fallback).id,
  orElse(copy[1], fallback).id,
  isMissing(cut[0]),
  isMissing(cut[1]),
  isMissing(dense[0]),
);

// What a generic map over the holed array returns, read the same ways.
const ns: number[] = mapAll(parts, (p) => p.n);
let seen = 0;
ns.forEach((n) => {
  seen += n === undefined ? 100 : n;
});
console.log(
  "mapped",
  ns.length,
  0 in ns,
  1 in ns,
  seen,
  ns.map((n) => (n === undefined ? -1 : n * 2)).join(","),
  ns.filter((n): boolean => n !== undefined).length,
  ns.reduce((a, n) => a + (n === undefined ? 1000 : n), 0),
);
const again = clone(ns);
console.log(
  "mapped copy",
  again.length,
  0 in again,
  again.map((n) => (n === undefined ? -1 : n * 2)).join(","),
  again.filter((n): boolean => n === undefined).length,
);
