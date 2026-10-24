// Speculative integer loops over writes that call small pure number
// functions, use Math.pow(2, n) and Math.floor(a / 2^n), read bytes, or
// call other functions: every fallback gives Node's numbers.
function trim(value: number, length: number): number {
  return value - Math.floor(value / Math.pow(2, length)) * Math.pow(2, length);
}
function maybeTrim(value: number | undefined, length: number): number {
  return (value ?? 0) - Math.floor((value ?? 0) / Math.pow(2, length)) * Math.pow(2, length);
}

function chain(codes: Uint8Array, length: number): number {
  const mask = length * 2 - 2;
  let key = 0;
  let sum = 0;
  for (let i = 0; i < codes.length; ++i) {
    sum = (sum + key) % 1000000007;
    key = trim(key, mask) * 4 + codes[i]!;
  }
  return sum * 31 + key;
}

function optionalChain(codes: Uint8Array, length: number): number {
  let key = 0;
  let sum = 0;
  for (let i = 0; i < codes.length; ++i) {
    sum = (sum * 3 + key) % 1000003;
    key = maybeTrim(key, length * 2) * 4 + codes[i]!;
  }
  return sum + key;
}

// Exponents past 52, negative and fractional values, and NaN reads leave
// the integer copy and finish in the double one.
function shifts(start: number, exponent: number, steps: number): number[] {
  const out: number[] = [];
  let v = start;
  for (let i = 0; i < steps; i++) {
    v = Math.floor(v / Math.pow(2, exponent)) * 3 + i * 7;
    out.push(v);
  }
  return out;
}

let calls = 0;
function noisy(x: number): number {
  calls++;
  return x % 5 === 0 ? x / 2 : x * 2;
}
// A call that the write cannot expand runs once per iteration, also on
// the iteration whose check fails.
function hoisted(n: number): number {
  let acc = 1;
  for (let i = 0; i < n; i++) acc = (acc * 7 + noisy(i)) % 1000003;
  return acc;
}

const codes = new Uint8Array(5000);
let seed = 7;
for (let i = 0; i < codes.length; i++) {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  codes[i] = seed % 4;
}
for (const length of [1, 2, 3, 6, 12, 18, 27]) console.log(length, chain(codes, length), optionalChain(codes, length));
console.log(shifts(1000, 3, 6), shifts(-1000, 2, 6), shifts(5, 53, 3), shifts(7.5, 1, 3), shifts(2 ** 52, 1, 3));
console.log(hoisted(20), calls);
const short = codes.subarray(0, 3);
console.log(chain(short, 2), chain(new Uint8Array(0), 2));
