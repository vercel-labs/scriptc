// Set, Map, WeakSet and Object.fromEntries over checked-dynamic iterables:
// native iterators, generators, objects with a Symbol.iterator method and
// collections, as seeds that reach the runtime untyped.
function* pairs() { yield ["g", 1]; yield ["h", 2]; }
function* values() { yield 1; yield 2; yield 2; }
const iterable = { *[Symbol.iterator]() { yield ["i", 3]; } };
const valueIterable = { *[Symbol.iterator]() { yield "a"; yield "b"; } };
function attempt(label, make) {
  try { console.log(label, make()); } catch (e) { console.log(label, "threw", e.name, e.message); }
}
function viaSet(x) { return new Set(x).size; }
function viaMap(x) { return [...new Map(x).keys()].join(); }
function viaWeakSet(x) { return new WeakSet(x).has(key); }
const key = {};
const m = new Map([["a", 1], ["b", 2]]);
attempt("set keys()", () => viaSet(m.keys()));
attempt("set values()", () => viaSet(new Set([1, 2]).values()));
attempt("set generator", () => viaSet(values()));
attempt("set iterable", () => viaSet(valueIterable));
attempt("set string", () => viaSet("abca"));
attempt("set number", () => viaSet(5));
attempt("map generator", () => viaMap(pairs()));
attempt("map iterable", () => viaMap(iterable));
attempt("map set", () => viaMap(new Set([["s", 1]])));
attempt("map entries()", () => viaMap(m.entries()));
attempt("map bad entry", () => viaMap([1]));
attempt("weakset generator", () => viaWeakSet((function* () { yield key; })()));
attempt("fromEntries generator", () => JSON.stringify(Object.fromEntries(pairs())));
