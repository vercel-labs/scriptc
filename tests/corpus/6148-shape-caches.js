// Dynamic-tier inline caches over shaped objects: each property site below
// runs many times over objects of several shapes, so its cache fills,
// rotates and must notice every change a cached answer depends on: new and
// deleted keys, prototype changes, accessors, read-only and frozen
// properties, non-extensible objects, arrays and parsed records.
function dyn(value) {
  return value;
}
function getX(o) {
  return o.x;
}
function setX(o, v) {
  o.x = v;
}
function setXStrict(o, v) {
  "use strict";
  o.x = v;
}
function getAt(o, k) {
  return o[k];
}
function callM(o) {
  return o.m();
}

// One read site, many shapes (polymorphic and past the cache size).
var shapes = dyn([
  { x: 1 },
  { y: 2, x: 3 },
  { x: 4, y: 5, z: 6 },
  { w: 0, x: 7 },
  { a: 1, b: 2, x: 8 },
  { x: 9, q: true },
  { nox: 1 },
]);
var total = 0;
for (var round = 0; round < 3; round++)
  for (var i = 0; i < shapes.length; i++) {
    var v = getX(shapes[i]);
    total += v === undefined ? 100 : v;
  }
console.log("poly", total);

// Writes: replace, then add, then a key that appears later.
var built = dyn([]);
for (var i = 0; i < 6; i++) {
  var o = dyn(i % 2 ? { x: 0 } : {});
  setX(o, i * 10);
  built.push(o);
}
console.log("set", JSON.stringify(built));
var grow = dyn({ a: 1 });
for (var i = 0; i < 4; i++) {
  setX(grow, i);
  grow["k" + i] = i;
}
console.log("grow", Object.keys(grow).join(","), getX(grow));

// Deleting and re-adding a key moves it to the end of the key order.
var del = dyn({ x: 1, y: 2 });
for (var i = 0; i < 3; i++) getX(del);
delete del.x;
console.log("deleted", getX(del), "x" in del, Object.keys(del).join(","));
setX(del, 5);
console.log("readded", getX(del), Object.keys(del).join(","));

// Integer-like keys enumerate first, ascending, whatever the insertion order.
var ints = dyn({});
ints.b = 1;
ints[2] = "two";
ints.a = 2;
ints[1] = "one";
ints["10"] = "ten";
for (var i = 0; i < 3; i++) getAt(ints, "a");
console.log("order", Object.keys(ints).join(","), getAt(ints, 2), getAt(ints, "1"));

// Prototype methods: cached through the prototype, then shadowed, replaced
// and added on the prototype after instances exist.
function Point(x) {
  this.x = x;
}
Point.prototype.m = function () {
  return "proto:" + this.x;
};
var pts = dyn([new Point(1), new Point(2), new Point(3)]);
var out = dyn([]);
for (var i = 0; i < pts.length; i++) out.push(callM(pts[i]));
pts[1].m = function () {
  return "own:" + this.x;
};
for (var i = 0; i < pts.length; i++) out.push(callM(pts[i]));
Point.prototype.m = function () {
  return "replaced:" + this.x;
};
for (var i = 0; i < pts.length; i++) out.push(callM(pts[i]));
console.log("methods", out.join(" "));
Point.prototype.later = 42;
console.log("later", pts[0].later, pts[2].later, "later" in pts[1]);
delete dyn(Point.prototype).later;
console.log("gone", pts[0].later);

// Getters and setters are never answered by a cache.
var counter = 0;
var acc = dyn({
  get x() {
    counter++;
    return "getter" + counter;
  },
});
var mixed = dyn([{ x: "plain" }, acc, { x: "plain2" }, acc]);
var got = dyn([]);
for (var i = 0; i < mixed.length; i++) got.push(getX(mixed[i]));
console.log("getters", got.join(" "), counter);
var sets = dyn([]);
var withSetter = dyn({
  /** @param {any} v */
  set x(v) {
    sets.push(v);
  },
});
for (var i = 0; i < 3; i++) setX(withSetter, i);
console.log("setters", sets.join(","));
var inherits = Object.create(withSetter);
setX(inherits, "via-proto");
console.log("proto-setter", sets.join(","), Object.keys(inherits).length);

// Read-only, frozen and non-extensible objects (strict writes throw).
var ro = dyn({ x: 1 });
Object.defineProperty(ro, "x", { writable: false });
try {
  setXStrict(ro, 2);
} catch (error) {
  console.log("ro-throw", error instanceof TypeError);
}
console.log("ro", getX(ro));
var frozen = dyn({ x: 1 });
for (var i = 0; i < 3; i++) setX(frozen, i);
Object.freeze(frozen);
try {
  setXStrict(frozen, 99);
} catch (error) {
  console.log("frozen-throw", error instanceof TypeError);
}
console.log("frozen", getX(frozen), Object.isFrozen(frozen));
var closed = dyn({ y: 1 });
Object.preventExtensions(closed);
try {
  setXStrict(closed, 3);
} catch (error) {
  console.log("closed-throw", error instanceof TypeError);
}
console.log("closed", getX(closed), "x" in closed);

// Arrays: elements, holes, length and out-of-range indexes.
var arr = dyn([10, 20, 30]);
var holey = dyn([1, , 3]);
var reads = dyn([]);
for (var i = -1; i < 5; i++) reads.push(String(getAt(arr, i)), String(getAt(holey, i)));
console.log("arrays", reads.join(","), getAt(arr, 1.5), getAt(arr, "1"), arr.length, holey.length);
arr.length = 1;
console.log("truncated", getAt(arr, 1), arr.length);

// Parsed records share shapes; writes keep later reads exact.
var parsed = JSON.parse('[{"id":1,"name":"a"},{"id":2,"name":"b"},{"name":"c","id":3}]');
var ids = dyn([]);
for (var i = 0; i < parsed.length; i++) ids.push(getAt(parsed[i], "id") + ":" + getAt(parsed[i], "name"));
parsed[0].name = "changed";
parsed[1].extra = true;
delete dyn(parsed[2]).id;
for (var i = 0; i < parsed.length; i++) ids.push(getAt(parsed[i], "id") + ":" + getAt(parsed[i], "name"));
console.log("parsed", ids.join(" "), JSON.stringify(parsed));

// A wide object (dictionary mode) and keys that change its layout.
var wide = dyn({});
for (var i = 0; i < 100; i++) wide["p" + i] = i;
var sum = 0;
for (var i = 0; i < 100; i++) sum += getAt(wide, "p" + i);
setX(wide, "wx");
console.log("wide", sum, getX(wide), Object.keys(wide).length);

// Prototype swaps and null-prototype objects.
var protoA = dyn({ x: "A" });
var protoB = dyn({ x: "B" });
var child = Object.create(protoA);
var seen = dyn([]);
for (var i = 0; i < 3; i++) seen.push(getX(child));
Object.setPrototypeOf(child, protoB);
seen.push(getX(child));
protoB.x = "B2";
seen.push(getX(child));
setX(child, "own");
seen.push(getX(child), protoB.x);
var bare = Object.create(null);
setX(bare, "bare");
seen.push(getX(bare));
console.log("protos", seen.join(" "));

// Numbers written back into objects keep their identity-free values.
var acc2 = dyn({ n: 0, f: 0.5 });
for (var i = 0; i < 1000; i++) {
  acc2.n += i;
  acc2.f = acc2.f * 1.5 - acc2.n / 1000;
}
var alias = acc2.n;
acc2.n = -0;
console.log("numbers", acc2.n, Object.is(acc2.n, -0), alias, acc2.f.toFixed(6));
