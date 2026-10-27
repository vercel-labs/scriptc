// TypedArray search on untyped values (parameters of untyped functions and
// object members): needles that are not numbers are never found (strict
// equality), fromIndex may be undefined, a string or a fraction, and
// Buffers keep their own indexOf, which wraps number needles and takes
// strings.
function views(bytes, floats, shorts) {
  return { bytes, floats, shorts };
}
const { bytes, floats, shorts } = views(
  new Uint8Array([1, 2, 10, 3, 10]),
  new Float64Array([0.5, NaN, -0]),
  new Int16Array([-1, 300, -1]),
);
console.log(bytes.indexOf(10), bytes.indexOf(10, 3), bytes.lastIndexOf(10), bytes.includes(3), bytes.includes(4));
console.log(bytes.lastIndexOf(1, undefined), bytes.lastIndexOf(10), bytes.indexOf(10, undefined), bytes.includes(1, undefined));
console.log(bytes.indexOf(10, '3'), bytes.indexOf(10, 2.9), bytes.indexOf(10, -1), bytes.lastIndexOf(10, -2), bytes.indexOf(10, null));
console.log(bytes.indexOf('10'), bytes.includes('1'), bytes.indexOf(10n), bytes.indexOf(), bytes.includes(), bytes.indexOf(266));
console.log(floats.indexOf(NaN), floats.includes(NaN), floats.indexOf(0), floats.lastIndexOf(-0), floats.includes(0.5, 1));
console.log(shorts.indexOf(-1), shorts.lastIndexOf(-1), shorts.indexOf(300, -2), shorts.includes(65535));
const holder = { view: bytes.subarray(2) };
console.log(holder.view.indexOf(10), holder.view.lastIndexOf(10), holder.view.includes(1));
const buffer = Buffer.from([1, 2, 10, 3, 10]);
const boxed = [buffer];
console.log(boxed[0].indexOf(10), boxed[0].indexOf(266), boxed[0].indexOf('\n'), boxed[0].includes(Buffer.from([3, 10])));
console.log(boxed[0].subarray(3).indexOf(10), Buffer.isBuffer(boxed[0].subarray(3)), boxed[0].lastIndexOf(10, -2));
let count = 0;
for (let at = bytes.indexOf(10); at !== -1; at = bytes.indexOf(10, at + 1)) count++;
console.log('count', count);
