// Loops whose versioning guard can fail, so they run the ordinary copy:
// arrays whose holes were filled later, counted loops that read past the
// end, arrays that change length inside the loop, typed-array windows past
// the end, fractional and NaN bounds, and callbacks that are replaced. The
// loops keep integer counters and sums that would also suit integer
// speculation, with values past 2^31 and 2^53, negative zero and fractions.

function sum(values: number[]): string {
  let total = 0;
  let count = 0;
  let seed = 12345;
  let grow = 1;
  for (let i = 0; i < values.length; i++) {
    total += values[i]!;
    count++;
    seed = (seed * 1103515245 + 12345) % 2147483648;
    grow = grow * 7 + i;
  }
  return `${total} ${count} ${seed} ${grow}`;
}

function product(values: number[], limit: number): string {
  let p = 1;
  let steps = 0;
  for (let i = 0; i < limit; i++) {
    p *= values[i] ?? 1;
    steps += 3;
  }
  return `${p} ${steps}`;
}

function shrinking(values: number[]): string {
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    total += values[i]! * i;
    if (values[i]! % 3 === 0) values.pop();
  }
  return `${total} ${values.length}`;
}

function windowSum(a: Int32Array, from: number, to: number): string {
  let total = 0;
  let mix = 1;
  for (let i = from; i < to; i++) {
    total += a[i] ?? -1;
    mix = (mix * 31 + 17) % 65521;
  }
  return `${total} ${mix}`;
}

function bytes(a: Uint8Array, start: number, n: number): string {
  let hash = 0;
  let steps = 0;
  for (let i = start; i < start + n; i++) {
    hash = (hash * 31 + (a[i] ?? 7)) | 0;
    steps++;
  }
  return `${hash} ${steps}`;
}

function counted(values: Float64Array, n: number, step: number): string {
  let total = 0;
  let odd = 0;
  for (let i = 0; i < n; i += step) {
    values[i] = i * 2;
    total += i;
    odd = odd * 2 + 1;
  }
  return `${total} ${odd} ${values.join()}`;
}

function mapped(values: number[], f: (x: number) => number): string {
  let total = 0;
  let k = 0;
  for (let i = 0; i < values.length; i++) {
    total += f(values[i]!);
    k = k * 10 + 1;
  }
  return `${total} ${k}`;
}

function lastNegativeZero(values: number[]): string {
  let last = 0;
  let zero = 0;
  for (let i = 0; i < values.length; i++) {
    last = values[i]! * -1;
    zero = zero * -1;
  }
  return `${Object.is(last, -0) ? "-0" : String(last)} ${Object.is(zero, -0) ? "-0" : zero}`;
}

/** An array written out of order: index 2 first, then the hole at 1. */
function filledLate(): number[] {
  const values: number[] = [1];
  values[2] = 3;
  values[1] = 2;
  return values;
}

console.log(sum([1, 2, 3, 4, 5]));
console.log(sum(filledLate()));
console.log(sum([1, 2.5, 3]));
console.log(sum([2147483647, 2147483647, 2147483647]));
console.log(sum([9007199254740991, 2, 2]));
console.log(sum(Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? i : -i))));

console.log(product([1, 2, 3, 4], 4));
console.log(product([1, 2, 3, 4], 6));
console.log(product([65536, 65536, 65536], 3));
console.log(product([0, -1], 2), product([-1, 0], 2));

console.log(shrinking([1, 2, 3, 4, 5, 6, 7, 8, 9]));
console.log(shrinking([3, 3, 3, 3]));

const ints = new Int32Array([10, 20, 30, 40]);
console.log(windowSum(ints, 0, 4), windowSum(ints, 2, 7), windowSum(ints, -2, 2));
console.log(windowSum(ints, 0.5, 3.5), windowSum(ints, 0, NaN));

const text = new Uint8Array([104, 101, 108, 108, 111]);
console.log(bytes(text, 0, 5), bytes(text, 3, 5), bytes(text, -1, 3));

console.log(counted(new Float64Array(12), 10, 1), counted(new Float64Array(12), 10.5, 1));
console.log(counted(new Float64Array(12), 10, 2.5), counted(new Float64Array(4), NaN, 1));
console.log(counted(new Float64Array(4), 8, 1), counted(new Float64Array(4), 3, 0.75));
console.log(counted(new Float64Array(60), 60, 1).split(" ").slice(0, 2).join(" "));

let calls = 0;
const double = (x: number): number => {
  calls++;
  return x * 2;
};
const half = (x: number): number => {
  calls++;
  return x / 2;
};
console.log(mapped([1, 2, 3], double), mapped([1, 2, 3], half), calls);
console.log(mapped(filledLate(), double), mapped([1, 2.5], (x) => x * x), calls);

console.log(lastNegativeZero([1, 2, 0]), lastNegativeZero([1, 2, 3]), lastNegativeZero([]));
