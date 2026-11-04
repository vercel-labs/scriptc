// Loops whose state is written only as a remainder by a literal, entered
// with seeds inside and outside the remainder's range, as fractions, -0 and
// NaN, from a parameter and from a module global.
let last = 42;

function fill(out: Float64Array, count: number): void {
  let seed = last;
  for (let i = 0; i < count; i++) {
    seed = (seed * 3877 + 29573) % 139968;
    out[i] = seed / 139968;
  }
  last = seed;
}

function steps(seed: number, count: number): number {
  let sum = 0;
  let i = 0;
  while (i < count) {
    seed = (seed * 1103 + 12345) % 65536;
    sum += seed;
    i++;
  }
  return sum + seed / 1000;
}

function mixed(seed: number, count: number): number {
  let total = 0;
  for (let i = 0; i < count; i++) {
    seed = (seed * 31 + i) % 1000003;
    if (i % 7 === 0) seed = (seed + 5) % 997;
    total = (total + seed) % 2147483647;
  }
  return total * 1000 + seed;
}

const out = new Float64Array(8);
fill(out, 8);
console.log(Array.from(out).map((x) => x.toFixed(6)).join(" "), last);
for (const start of [-17, 139968, 2 ** 40, 0.5, -0, NaN, Infinity, 7]) {
  last = start;
  fill(out, 4);
  console.log(String(start), Array.from(out).map((x) => x.toFixed(6)).join(" "), last);
}
for (const seed of [0, 65535, 65536, -1, 1e15, 2.25, -0, NaN])
  console.log(String(seed), steps(seed, 50), Object.is(steps(seed, 0), -0));
for (const seed of [3, 1000002, -5, 2 ** 31, 0.75])
  console.log(String(seed), mixed(seed, 40));
