// %TypedArray%.prototype methods called on typed arrays held as untyped
// values, as JavaScript sources and Test262's testTypedArray.js use them.
const kinds = [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array];

function show(label, value) {
  console.log(label, value);
}

// TA arrives untyped, as Test262's testWithTypedArrayConstructors passes it.
function check(TA) {
  const a = new TA([3, 1, 2, 1, 0]);
  show(TA.name + " search", [a.indexOf(1), a.lastIndexOf(1), a.includes(2), a.indexOf(1, 2), a.lastIndexOf(1, -3), a.includes(3, 1), a.indexOf(9), a.indexOf("1")]);
  show("  map", a.map((v, i) => v * 2 + i));
  show("  filter", a.filter((v) => v > 0));
  show("  some/every", [a.some((v) => v > 2), a.every((v) => v >= 0), a.every((v) => v > 0)]);
  show("  find", [a.find((v) => v < 2), a.findIndex((v) => v < 2), a.findLast((v) => v < 2), a.findLastIndex((v) => v < 2), a.find((v) => v > 5), a.findLastIndex((v) => v > 5)]);
  show("  reduce", [a.reduce((s, v) => s + v), a.reduceRight((s, v, i) => s + "" + v + i, ""), a.reduce((s, v) => s * 10 + v, 0)]);
  const seen = [];
  a.forEach(function (v, i, arr) { seen.push([v, i, arr === a, this.tag]); }, { tag: "t" });
  show("  forEach", seen.map((x) => x.join(":")).join(" "));
  show("  sorted", [a.toSorted().join(), a.toSorted((x, y) => y - x).join(), a.toReversed().join(), a.with(1, 7).join(), a.with(-1, 9).join(), a.join()]);
  show("  iterators", [[...a.keys()].join(), [...a.values()].join(), [...a.entries()].map((e) => e.join("=")).join(" ")]);
  const b = a.slice();
  b.sort();
  show("  sort", [b.join(), b.reverse().join(), b.sort((x, y) => x - y) === b]);
}
kinds.forEach(check);

// Edge cases over untyped constructors.
function edges(F, C, I, U, S) {
  const f = new F([NaN, -0, 0, 1, -Infinity, NaN]);
  show("float search", [f.indexOf(NaN), f.includes(NaN), f.indexOf(-0), f.lastIndexOf(0), f.includes(-0)]);
  show("float sort", Array.from(f.toSorted(), (v) => Object.is(v, -0) ? "-0" : String(v)).join());
  show("clamped map", new C([1, 2]).map((v) => v * 200));
  show("wrapping map", new I([1, 2]).map((v) => v * 100));
  const live = new U([1, 2, 3]);
  show("live", live.map((v, i, arr) => { if (i === 0) arr[2] = 9; return v; }));
  for (const bad of [() => new I(2).forEach(1), () => new I(0).reduce((a, b) => a), () => new I(2).with(5, 1), () => new I(2).sort("x")]) {
    try {
      bad();
      show("no throw", "");
    } catch (e) {
      show(e.constructor.name, e.message.length > 0);
    }
  }
  let order = [];
  new S([5, 1, 4]).sort((x, y) => { order.push(x + "" + y); return x - y; });
  show("comparator calls", order.length > 0);
}
edges(Float64Array, Uint8ClampedArray, Int8Array, Uint8Array, Int16Array);

// Method values, and the constructors' from and of.
function run(TA) {
  const s = new TA([1, 2, 3]);
  console.log(typeof s.findLast, typeof s.with, typeof s.toSorted, typeof s.map, typeof s.at);
  const m = s.findLast;
  console.log(m.call(s, (v) => v < 3));
  console.log(typeof TA.from, typeof TA.of);
}
run(Int16Array);
function statics(TA) {
  console.log(TA.from([1, 2, 300]), TA.from({ length: 2, 0: "7", 1: 8 }), TA.from(new Set([4, 5]), (v, k) => v * 10 + k));
  console.log(TA.of(1, 2, 3), TA.of(), TA.from({ [Symbol.iterator]: function* () { yield 9; yield 8; } }));
  try { TA.from([1], 5); } catch (e) { console.log(e.constructor.name); }
  try { TA.from(null); } catch (e) { console.log(e.constructor.name); }
}
statics(Uint8Array);
statics(Float32Array);

// TypedArray.from and TypedArray.of with other constructors as this.
function customs(TA) {
  let calls = [];
  function Big(n) { calls.push(n); return new TA(n + 2); }
  const fromBig = TA.from.call(Big, [1, 2, 3], (v) => v * 2);
  console.log(fromBig, calls);
  console.log(TA.of.call(Big, 7, 8));
  function attempt(label, C) {
    try { TA.from.call(C, [1, 2]); console.log(label, "no throw"); } catch (e) { console.log(label, e.constructor.name); }
    try { TA.of.call(C, 1, 2); console.log(label, "no throw"); } catch (e) { console.log(label, e.constructor.name); }
  }
  attempt("small", function () { return new TA(1); });
  attempt("plain", function () { return {}; });
  attempt("arrow", () => new TA(5));
  attempt("number", 5);
  const order = [];
  const arrayLike = { length: 2, get 0() { order.push("get0"); return 1; }, get 1() { order.push("get1"); return 2; } };
  TA.from.call(function (n) { order.push("create" + n); return new TA(n); }, arrayLike, (v) => { order.push("map" + v); return v; });
  console.log(order.join(" "));
}
customs(Int32Array);

// Reducers and comparators run with an undefined this, also through method
// values; a Symbol.iterator getter is read once.
function review(TA) {
  "use strict";
  const ta = new TA([3, 1, 2]);
  const seen = [];
  const reduce = ta.reduce, reduceRight = ta.reduceRight, sort = ta.sort, toSorted = ta.toSorted;
  reduce.call(ta, function (a, b) { seen.push(this === undefined); return a + b; });
  reduceRight.call(ta, function (a, b) { seen.push(this === undefined); return a + b; }, 0);
  sort.call(ta.slice(), function (x, y) { seen.push(this === undefined); return x - y; });
  toSorted.call(ta, function (x, y) { seen.push(this === undefined); return y - x; });
  console.log(seen.every((v) => v), seen.length > 0);
  let gets = 0;
  const source = {};
  Object.defineProperty(source, Symbol.iterator, { get() { gets++; return function* () { yield 4; yield 5; }; } });
  console.log(new TA(source), gets);
  console.log(TA.from(source), gets);
}
review(Uint8Array);
function plainIterator(TA) {
  let gets = 0, nexts = 0;
  const source = {};
  Object.defineProperty(source, Symbol.iterator, {
    get() {
      gets++;
      return function () {
        let i = 0;
        return { next() { nexts++; return i < 2 ? { value: 10 + i++, done: false } : { value: undefined, done: true }; } };
      };
    },
  });
  console.log(new TA(source), TA.from(source, (v) => v * 2), gets, nexts);
}
plainIterator(Int16Array);
// ToIndex of a Symbol or BigInt length, toLocaleString, and Symbol descriptions
// that are not strings.
function small(TA) {
  for (const bad of [Symbol("s"), 1n]) {
    try { new TA(bad); console.log("no throw"); } catch (e) { console.log(e.constructor.name); }
  }
  console.log(new TA([1, 1234.5, -0, 0]).toLocaleString(), new TA(0).toLocaleString(), typeof new TA(1).toLocaleString);
}
small(Float64Array);
small(Uint16Array);
const s = Symbol(1), t = Symbol(true), u = Symbol(2.5);
console.log(s.description, t.description, u.toString(), typeof s.description);
