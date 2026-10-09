// Integer- and float-heavy kernels: sieve, hashing, matrix multiply on
// number[][], histogram on plain arrays, and a Float64Array smoothing pass.
function sieve(limit: number): number {
  const composite: boolean[] = new Array<boolean>(limit + 1).fill(false);
  let count = 0;
  for (let i = 2; i <= limit; i++) {
    if (composite[i]) continue;
    count++;
    for (let j = i * i; j <= limit; j += i) composite[j] = true;
  }
  return count;
}
function fnv(values: number[]): number {
  let h = 2166136261;
  for (let i = 0; i < values.length; i++) {
    h ^= values[i]! & 0xff;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}
function matmul(a: number[][], b: number[][], n: number): number[][] {
  const c: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row: number[] = new Array<number>(n).fill(0);
    const ai = a[i]!;
    for (let k = 0; k < n; k++) {
      const aik = ai[k]!;
      const bk = b[k]!;
      for (let j = 0; j < n; j++) row[j] = row[j]! + aik * bk[j]!;
    }
    c.push(row);
  }
  return c;
}

const scale = Number(process.argv[2] ?? "1");
const primes = sieve(Math.floor(2000000 * scale));
const data: number[] = [];
let x = 1;
for (let i = 0; i < Math.floor(1000000 * scale); i++) {
  x = (Math.imul(x, 48271) + 11) & 0x7fffffff;
  data.push(x % 1000);
}
let hash = 0;
for (let r = 0; r < 4; r++) hash = (hash + fnv(data)) >>> 0;
const histogram: number[] = new Array<number>(100).fill(0);
for (let i = 0; i < data.length; i++) {
  const bucket = data[i]! % 100;
  histogram[bucket] = histogram[bucket]! + 1;
}
const n = Math.floor(120 * Math.sqrt(scale));
const a: number[][] = [];
const b: number[][] = [];
for (let i = 0; i < n; i++) {
  const ra: number[] = [];
  const rb: number[] = [];
  for (let j = 0; j < n; j++) {
    ra.push(((i * j) % 7) - 3);
    rb.push(((i + j) % 5) - 2);
  }
  a.push(ra);
  b.push(rb);
}
const c = matmul(a, b, n);
let trace = 0;
for (let i = 0; i < n; i++) trace += c[i]![i]!;
const signal = new Float64Array(data.length);
for (let i = 0; i < data.length; i++) signal[i] = data[i]! / 7;
let smooth = 0;
for (let pass = 0; pass < 3; pass++) {
  for (let i = 1; i < signal.length - 1; i++) signal[i] = (signal[i - 1]! + signal[i]! * 2 + signal[i + 1]!) / 4;
}
for (let i = 0; i < signal.length; i += 1000) smooth += signal[i]!;
console.log("primes", primes, "hash", hash, "hist", histogram[0], histogram[99], "trace", trace, "smooth", smooth.toFixed(6));
