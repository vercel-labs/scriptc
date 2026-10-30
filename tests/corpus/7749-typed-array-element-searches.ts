// TypedArray indexOf, lastIndexOf and includes on every element kind, on
// Buffers (their own search), and on unions of typed arrays: strict
// equality for indexOf/lastIndexOf, SameValueZero for includes.
const f = new Float64Array([1, NaN, -0, 0, 2.5, NaN, 1]);
console.log(f.indexOf(NaN), f.includes(NaN), f.lastIndexOf(NaN));
console.log(f.indexOf(0), f.indexOf(-0), f.lastIndexOf(0), f.lastIndexOf(-0), f.includes(-0));
console.log(f.indexOf(1, 1), f.indexOf(1, -1), f.indexOf(1, -100), f.indexOf(1, 100), f.indexOf(1, 1.9));
console.log(f.lastIndexOf(1, 5), f.lastIndexOf(1, -2), f.lastIndexOf(1, -100), f.lastIndexOf(1, 100), f.lastIndexOf(1, undefined));
console.log(f.includes(2.5, 4), f.includes(2.5, 5), f.includes(2.5, -3), f.includes(NaN, 6));
const u = new Uint8Array([0, 255, 3, 255]);
console.log(u.indexOf(255), u.indexOf(-1), u.indexOf(511), u.indexOf(3.5), u.includes(NaN), u.lastIndexOf(255));
const i = new Int16Array([-5, 7, -5]);
console.log(i.indexOf(-5), i.lastIndexOf(-5), i.includes(7), i.indexOf(65531));
const h = new Float32Array([0.1, 0.5, 16777217]);
console.log(h.indexOf(0.1), h.indexOf(0.5), h.includes(16777216), h.indexOf(16777217));
const c = new Uint8ClampedArray([300, -4]);
console.log(c.indexOf(255), c.indexOf(0), new Uint32Array(0).indexOf(0), new Uint32Array(0).includes(0));
const b = Buffer.from([1, 2, 3, 2]);
console.log(b.indexOf(2), b.indexOf(258), b.lastIndexOf(2), b.includes("\u0003"));
type UintArray = Uint8Array | Uint16Array | Uint32Array;
const mk = (n: number): UintArray => (n > 1 ? new Uint16Array([1, 700, 1]) : new Uint8Array([1, 188, 1]));
for (const x of [mk(1), mk(2)]) console.log(x.indexOf(700), x.lastIndexOf(1), x.includes(188), x.indexOf(1, 1));
