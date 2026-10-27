// Float16Array from JavaScript: construction from lengths, arrays, typed
// arrays and ArrayBuffer views; round-to-nearest-even stores with overflow,
// NaN, -0 and subnormals; fill, set, subarray, slice and both sort orders;
// DataView getFloat16 and setFloat16 in both byte orders; Math.f16round;
// util.types and instanceof; structuredClone, assert and Buffer views.
// Node.js prints the same.
import { types } from "node:util";
import assert from "node:assert";
const show = (label        , a              )       => console.log(label, a.length, Array.from(a).join(","));
const a = new Float16Array(6);
a[0] = 1.5;
a[1] = 65519;
a[2] = 65520;
a[3] = 0.1;
a[4] = -0;
a[5] = 5.960464477539063e-8 / 2;
show("rounding", a);
const b = new Float16Array([NaN, Infinity, -Infinity, 1e-8, 2049, 2051, 4097, -1e6]);
show("specials", b);
console.log(Object.is(a[4], -0), a[6], a.length, a.byteLength, Number.isNaN(b[0]));
const c = Float16Array.from([3.14159, 2.71828, 1.41421]);
show("from", c);
const e = new Float16Array(c);
e[0] = 100;
show("copy", e);
show("source untouched", c);
const f32 = new Float32Array([1 / 3, 2 / 3]);
show("from f32", new Float16Array(f32));
const buf = new ArrayBuffer(8);
const view = new Float16Array(buf, 2, 2);
view[0] = 1;
view[1] = -2;
console.log("view bytes", Array.from(new Uint8Array(buf)).join(","), new Uint16Array(buf)[1]);
const g = new Float16Array(5);
g.fill(0.3);
show("fill", g);
g.set([1.1, 2.2], 3);
show("set", g);
show("subarray", g.subarray(1, 4));
show("slice", g.slice(-2));
const h = new Float16Array([3, -0, 0, NaN, -1, 2.5, -Infinity, 0.1]);
show("sort", h.slice().sort());
show("sort desc", h.slice().sort((x, y) => y - x));
show("toSorted", h.toSorted());
let sum = 0;
for (const v of c) sum += v;
console.log("for-of", sum, h.join("|"), String(c), Object.prototype.toString.call(c));
const dv = new DataView(new ArrayBuffer(8));
dv.setFloat16(0, 3.14159);
dv.setFloat16(2, 3.14159, true);
dv.setFloat16(4, -65504);
dv.setFloat16(6, NaN, true);
console.log("dataview", dv.getFloat16(0), dv.getFloat16(2, true), dv.getFloat16(4), dv.getFloat16(6, true), dv.getUint16(0), dv.getUint16(2));
try {
  dv.getFloat16(7);
} catch (err) {
  console.log((err         ).name, (err         ).message);
}
console.log("f16round", Math.f16round(1.337), Math.f16round(65520), Math.f16round(-0), Math.f16round(5e-8), Math.f16round(2 ** -25), Math.f16round(1.0009765625 + 2 ** -12));
console.log("types", types.isFloat16Array(a), types.isFloat32Array(a), types.isTypedArray(a), a instanceof Float16Array);
const u          = a;
console.log("unknown", u instanceof Float16Array, u instanceof Float32Array);
const big = new Float16Array(1000);
for (let i = 0; i < big.length; i++) big[i] = Math.sin(i) * 1000;
let acc = 0;
for (let i = 0; i < big.length; i++) acc += big[i] ;
console.log("loop", acc, big[999]);
const f = new Float16Array([1.5, NaN, -0, 65504]);
const clone = structuredClone(f);
clone[0] = 2;
console.log(clone[0], f[0], clone.length);
assert.deepStrictEqual(new Float16Array([NaN, 1]), new Float16Array([NaN, 1]));
try {
  assert.deepStrictEqual(new Float16Array([0]), new Float16Array([-0]));
} catch (e) {
  console.log("deepStrictEqual -0", (e         ).name);
}
assert.deepEqual(new Float16Array([0]), new Float16Array([-0]));
const raw = Buffer.from(f.buffer);
console.log(raw.length, raw.readUInt16LE(0), raw.readUInt16LE(6));
const fromBuf = new Float16Array(f.buffer, 2, 1);
console.log(Number.isNaN(fromBuf[0]));
const list                 = [f, new Float16Array(2)];
const m = new Map                      ([["a", f]]);
console.log(list.length, m.get("a") [3], list[1] .length);
const Ctor = Float16Array;
const x = new Ctor(3);
x[1] = 0.2;
console.log(x.length, x[1]);
const y = new Float16Array([1, 2]);
const D = y.constructor                           ;
const z = new D(2);
console.log(z.length, z instanceof Float16Array);
const unknownView          = new Float16Array([7]);
console.log(unknownView instanceof Float16Array);
