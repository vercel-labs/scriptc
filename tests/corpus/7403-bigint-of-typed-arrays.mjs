// BigInt of a typed array converts the array to its elements joined with
// "," and parses that text, as in Node: one element reads as its value,
// an empty array as 0n, and anything else throws the SyntaxError for the
// joined text. Every element kind, negative and clamped values, float
// formatting, views and the results in arithmetic. A Buffer converts
// through its UTF-8 text instead, also when a typed array slot holds it,
// and a DataView through "[object DataView]".

const one = [
  new Int8Array([-5]),
  new Uint8Array([7]),
  new Uint8ClampedArray([300]),
  new Int16Array([-30000]),
  new Uint16Array([65535]),
  new Int32Array([-2147483648]),
  new Uint32Array([4294967295]),
  new Float32Array([-0]),
  new Float64Array([2 ** 60]),
];
for (const view of one) console.log(view.constructor.name, BigInt(view));

const empty = [new Uint8Array(0), new Float64Array([]), new Int32Array(8).subarray(3, 3)];
for (const view of empty) console.log("empty", view.constructor.name, BigInt(view));

const bad = [
  new Uint8Array([1, 2]),
  new Float64Array([1.5]),
  new Float32Array([NaN]),
  new Float64Array([1e21]),
  new Int16Array([3, -4, 5]),
  new Float64Array([Infinity]),
];
for (const view of bad) {
  try {
    console.log("unexpected", BigInt(view));
  } catch (e) {
    console.log(view.constructor.name, e instanceof SyntaxError, e.message);
  }
}

const bytes = new Uint8Array([9, 8, 7]);
const window = bytes.subarray(1, 2);
let total = 0n;
for (let i = 0; i < 100; i++) {
  bytes[1] = i;
  total += BigInt(window) * 3n;
}
console.log("window", BigInt(window), total, BigInt(bytes.subarray(2)) ** 2n);

function convert(label, make) {
  try {
    console.log(label, BigInt(make()));
  } catch (e) {
    console.log(label, e instanceof SyntaxError, e.message);
  }
}
convert("buffer", () => Buffer.from("12"));
convert("spaced buffer", () => Buffer.from(" -7 "));
convert("empty buffer", () => Buffer.alloc(0));
convert("fraction buffer", () => Buffer.from("1.5"));
convert("data view", () => new DataView(new ArrayBuffer(2)));
for (const view of [new Uint8Array([5]), Buffer.from("64")]) console.log("slot", BigInt(view));
