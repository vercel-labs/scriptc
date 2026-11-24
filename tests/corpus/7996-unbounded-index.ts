const a = new Uint32Array([4294967295]);
const t = new Uint8Array([11, 22, 33, 44]);
let k = 0;
for (let i = 0; i < 2; i++) k += 4294967295;
const idx = k * a[0]!;
console.log("idx", idx, "elem", t[idx]);
const d: number[] = [11, 22, 33, 44];
console.log("arr", d[idx]);
console.log("neg", t[-1], t[1e19], t[4], t[3]);

// The other end: a value below -2^63 makes the conversion poison too, and a
// frozen negative could pass the unsigned capacity comparison.
const big = -1e19;
const neg = new Uint8Array([11, 22, 33, 44]);
console.log("neg", neg[big]);
const dn: number[] = [11, 22, 33, 44];
console.log("dense neg", dn[big], dn[-big], dn[-1e19]);
let m = 0;
for (let i = 0; i < 2; i++) m -= 4294967295;
console.log("induction neg", neg[m * 4294967295], dn[m * 4294967295]);
