// Typed arrays: construction (ToIndex lengths), length/byteLength, and the
// element read/write coercion matrix — JS-exact ToUint8/ToUint32 modular
// truncation and double→float rounding, verified against Node. OOB element
// ACCESS is a documented divergence (scriptc traps where JS reads
// undefined / ignores the write), so only in-bounds behavior appears here.
const nan = 0 / 0;
const inf = 1 / 0;

const a = new Uint8Array(4);
console.log("len", a.length, a.byteLength);
console.log("zero", a[0], a[3]);
const vals = [3.7, -3.7, -1, 255, 256, 257, nan, inf, -inf, 1e10, 0.5, -0.5];
for (const v of vals) {
  a[0] = v;
  console.log("u8", a[0]);
}

const u = new Uint32Array(2);
console.log("ulen", u.length, u.byteLength);
const uvals = [
  -1,
  4294967296,
  4294967301,
  4.9,
  nan,
  inf,
  -inf,
  9007199254740992,
  9007199254740994,
  1e100,
  -1e100,
];
for (const v of uvals) {
  u[1] = v;
  console.log("u32", u[1]);
}

const f = new Float32Array(2);
f[0] = 0.1;
console.log("f32", f[0]);
f[1] = nan;
console.log("f32nan", f[1] !== f[1]);

console.log("frac", new Uint8Array(3.5).length);
console.log("nanlen", new Uint8Array(nan).length);
console.log("empty", new Uint8Array().length);

try {
  const bad = new Uint8Array(-1);
  console.log("no-throw", bad.length);
} catch (e) {
  if (e instanceof RangeError) {
    console.log("range", e.message);
  } else {
    console.log("not-a-rangeerror");
  }
}

// Construction from a number[] coerces per element; construction from a
// typed array (or Buffer) is an independent COPY.
const seeded = new Uint8Array([1, 2.7, -1, 256]);
console.log("seeded", seeded[0], seeded[1], seeded[2], seeded[3]);
const copy = new Uint8Array(seeded);
copy[0] = 9;
console.log("copy", seeded[0], copy[0]);

const useed = new Uint32Array([4294967295, 7]);
console.log("useed", useed[0], useed[1]);

// Receiver evaluation snapshots the old bytes before a later index/value
// expression overwrites its only binding. The optimized direct-binding
// borrow is intentionally disabled for these side-effecting operands.
let readOrder = new Uint8Array([11]);
function replaceReadOrder(): number {
  readOrder = new Uint8Array([22]);
  return 0;
}
const readBeforeReplace = readOrder[replaceReadOrder()];
console.log("read-order", readBeforeReplace, readOrder[0]);

let writeOrder = new Uint8Array([33]);
function replaceWriteOrder(): number {
  writeOrder = new Uint8Array([44]);
  return 55;
}
writeOrder[0] = replaceWriteOrder();
console.log("write-order", writeOrder[0]);

// Assignment expressions can hide the receiver overwrite beneath a boolean
// condition while the enclosing ternary still produces a numeric operand.
let nestedReadOrder = new Uint8Array([66]);
const nestedReadReplacement = new Uint8Array([77]);
const nestedReadBeforeReplace =
  nestedReadOrder[(nestedReadOrder = nestedReadReplacement) ? 0 : 0];
console.log("nested-read-order", nestedReadBeforeReplace, nestedReadOrder[0]);

let nestedWriteOrder = new Uint8Array([88]);
const nestedWriteReplacement = new Uint8Array([99]);
nestedWriteOrder[0] = (nestedWriteOrder = nestedWriteReplacement) ? 55 : 66;
console.log("nested-write-order", nestedWriteOrder[0]);
