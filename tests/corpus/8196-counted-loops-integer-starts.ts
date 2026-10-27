// Counted, paired and dense array loops whose start is an int32 value
// (an int32 array element, `p0 | 0` or one minus either): starts at -1, 0,
// inside the array, at its end, and at the int32 extremes, where the loop
// must not run or must stop at the array's end as Node does. Number arrays
// and an Int32Array both run their paired loops.
function reverse(pp: number[], p0: number): number {
  let swaps = 0;
  for (let i = 1, j = (p0 | 0) - 1; i < j; i++, j--) {
    const t = pp[i]!;
    pp[i] = pp[j]!;
    pp[j] = t;
    swaps++;
  }
  return swaps;
}

function reverseBytes(values: Int32Array, p0: number): number {
  let swaps = 0;
  for (let i = 0, j = (p0 | 0) - 1; i < j; i++, j--) {
    const t = values[i]!;
    values[i] = values[j]!;
    values[j] = t;
    swaps++;
  }
  return swaps;
}

function sumFrom(values: number[], start: number): number {
  let total = 0;
  for (let k = start - 1; k < values.length; k++) total += values[k] ?? 100;
  return total;
}

function countdown(values: Int32Array, from: number): number {
  let total = 0;
  for (let k = from; k >= 0; k--) total += values[k] ?? 1000;
  return total;
}

const starts: number[] = [0, 1, 2, 5, 9, 10, 11, 2147483647, -2147483648];
const ints = new Int32Array(starts);
for (let s = 0; s < ints.length; s++) {
  const p0 = ints[s]!;
  const pp = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const swaps = p0 <= 11 ? reverse(pp, p0) : 0;
  const bytes = new Int32Array(pp);
  const byteSwaps = p0 <= 11 ? reverseBytes(bytes, p0) : 0;
  console.log(p0, swaps, pp.join(""), p0 <= 11 && p0 >= -1 ? sumFrom(pp, p0) : "-", p0 <= 11 ? countdown(ints, p0) : "-");
  console.log(" bytes", byteSwaps, bytes.join(""));
}
