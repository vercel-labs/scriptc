// A typed-array loop whose initializer rebinds the array it indexes: the
// bounds the loop relies on belong to the array the initializer installs,
// so reads past the shorter replacement are undefined (NaN in arithmetic)
// and writes past it are ignored, as in JavaScript.

function sumAfterRebinding(data: Uint8Array, replacement: Uint8Array, n: number): number {
  let total = 0;
  for (let i = ((data = replacement), 0); i < n; i++) total += data[i];
  return total;
}

function fillAfterRebinding(data: Int32Array, replacement: Int32Array, n: number): Int32Array {
  for (let i = ((data = replacement), 0); i < n; i++) data[i] = i + 1;
  return data;
}

// The initializer assigns the receiver without declaring the counter.
function countAfterAssignment(data: Float64Array, replacement: Float64Array, n: number): number {
  let i: number;
  let total = 0;
  for (data = replacement, i = 0; i < n; i++) total += data[i];
  return total;
}

const long = new Uint8Array(64).fill(1);
const short = new Uint8Array(4).fill(2);
console.log("sum", sumAfterRebinding(long, short, 64));
console.log("sum in bounds", sumAfterRebinding(long, short, 4));

const target = new Int32Array(64);
const small = new Int32Array(3);
const filled = fillAfterRebinding(target, small, 64);
console.log("fill", filled.length, Array.from(filled).join(","), target[0], target[63]);

const wide = new Float64Array(32).fill(0.5);
const narrow = new Float64Array(2).fill(4);
console.log("count", countAfterAssignment(wide, narrow, 32));
console.log("count in bounds", countAfterAssignment(wide, narrow, 2));

// A loop whose initializer leaves the receiver alone still runs normally.
function plainSum(data: Uint8Array, n: number): number {
  let total = 0;
  for (let i = 0; i < n; i++) total += data[i];
  return total;
}
console.log("plain", plainSum(long, 64), plainSum(short, 6));
