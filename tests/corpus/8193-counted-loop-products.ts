// Nested counted loops whose bounds arrive at run time, with the counters'
// products reaching bitwise operators. Starts and limits take the integer
// copy or the double copy: negative, fractional, NaN, -0, and starts or
// limits past 2^25, past which the guarded copy no longer proves products
// exact.
function a(i: number, j: number): number {
  return (((i + j) * (i + j + 1)) >>> 1) + i + 1;
}

function rows(start: number, end: number, n: number): number[] {
  const out: number[] = [];
  for (let i = start; i < end; i++) {
    let t = 0;
    for (let j = 0; j < n; j++) t += 1 / a(i, j);
    out.push(t);
  }
  return out;
}

function mixed(start: number, end: number, n: number): number {
  let h = 0;
  for (let i = start; i < end; i++) {
    for (let j = start; j < n; j++) h = (h + ((i - j) * (j - i + 3) | 0)) | 0;
  }
  return h;
}

function wide(start: number, count: number): number[] {
  const out: number[] = [];
  for (let i = start; i < start + count; i++) out.push(((i * (i + 1)) >>> 0) ^ (i * i) | 0);
  return out;
}

const args = process.argv.slice(2).map(Number);
const big = 2 ** 25;
for (const [start, end, n] of [
  [0, 4, 6],
  [-3, 2, 5],
  [1.5, 4, 3],
  [-0, 2, 2],
  [NaN, 2, 2],
  [big - 2, big + 2, 3],
  [0, 3, args.length > 0 ? big + 1 : 4],
]) {
  console.log(start, end, n, rows(start!, end!, Math.min(n!, 8)).map((x) => x.toFixed(12)).join(" "));
  console.log("mixed", mixed(start!, end!, Math.min(n!, 8)));
}
for (const start of [0, -5, 2 ** 26, 2 ** 31 - 2, 2 ** 52, -(2 ** 40), 0.5]) console.log(start, wide(start, 4).join(" "));
console.log(Object.is(((-0 * 5) >>> 0), 0), a(-1, 0), a(0, -1), a(2 ** 30, 2 ** 30));

// Single-expression functions inlined at calls that pass literals and
// locals, also read as values and called with other arguments.
function mix(x: number, y: number): number {
  return ((x * 31 + y) ^ (y << 3)) % 1000;
}
const table = [mix, (x: number, y: number) => x - y];
let acc = 0;
for (let k = 0; k < 5; k++) acc += mix(k, 7) + mix(3, k) + table[k % 2]!(k, 2) + mix(k * 2, args.length);
console.log(acc, mix(2 ** 40, -0), mix(NaN, 1), mix(Infinity, 2), [1, 2, 3].map((v) => mix(v, v)).join());
