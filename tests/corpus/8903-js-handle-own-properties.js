"use strict";
// Own properties added to runtime handles: expandos, defineProperty,
// reflection, deletion and integrity, through typed and untyped references.
function setVia(o, k, v) { o[k] = v; }
function getVia(o, k) { return o[k]; }

const d = new Date(0);
d.tag = "x";
console.log("date", d.tag, Object.keys(d).join(","), d.getTime());
Object.defineProperty(d, "hidden", { value: 1, enumerable: false });
console.log("names", Object.keys(d).join(","), Object.getOwnPropertyNames(d).join(","), d.hidden);
console.log("desc", JSON.stringify(Object.getOwnPropertyDescriptor(d, "tag")), JSON.stringify(Object.getOwnPropertyDescriptor(d, "hidden")));
console.log("has", d.hasOwnProperty("tag"), "tag" in d, "nope" in d, Object.prototype.hasOwnProperty.call(d, "hidden"));
setVia(d, "viaHelper", 5);
console.log("helper", d.viaHelper, getVia(d, "tag"));
delete d.tag;
console.log("deleted", d.tag, Object.keys(d).join(","));
Object.preventExtensions(d);
console.log("extensible", Object.isExtensible(d), Object.isSealed(d), Object.isFrozen(d));
try { d.more = 1; } catch (e) { console.log("add", e.constructor.name, e.message); }
try { Object.defineProperty(d, "more", { value: 1 }); } catch (e) { console.log("define", e.constructor.name, e.message); }
d.viaHelper = 6;
console.log("write", d.viaHelper);
Object.freeze(d);
try { d.viaHelper = 7; } catch (e) { console.log("frozen", e.constructor.name, e.message); }
console.log("frozen?", Object.isFrozen(d), d.viaHelper, d.getTime());

const m = new Map([[1, 2]]);
m.label = "m";
console.log("map", m.label, m.size, m.get(1), Object.keys(m).join(","));
Object.seal(m);
console.log("map sealed", Object.isSealed(m), Object.isExtensible(m));

const re = /a/g;
re.note = 1;
console.log("regexp", re.note, re.test("a"), re.lastIndex, Object.keys(re).join(","));

const s = new Set();
Object.defineProperty(s, "marker", { get() { return this.size + 10; }, enumerable: true });
s.add(1);
console.log("set", s.marker, Object.keys(s).join(","), JSON.stringify(Object.getOwnPropertyDescriptor(s, "marker").get !== undefined));

const ab = new ArrayBuffer(8);
ab.extra = "e";
console.log("buffer", ab.extra, ab.byteLength, Object.keys(ab).join(","));

const descriptorSource = new Date(0);
descriptorSource.value = 7;
descriptorSource.enumerable = true;
const target = {};
Object.defineProperty(target, "p", descriptorSource);
console.log("descriptor", target.p, Object.keys(target).join(","));

const w = new Date(0);
Object.defineProperties(w, { aa: { value: 1, enumerable: true }, bb: { value: 2 } });
w.cc = 3;
const seen = [];
for (const key in w) seen.push(key);
console.log(
  "walk",
  seen.sort().join(","),
  Object.values(w).join(","),
  JSON.stringify(Object.entries(w)),
  w.propertyIsEnumerable("aa"),
  w.propertyIsEnumerable("getTime"),
);

const wm = new WeakMap();
wm.count = 3;
console.log("weakmap", wm.count, Object.getOwnPropertyNames(wm).join(","));
