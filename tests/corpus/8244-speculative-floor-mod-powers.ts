// Integer loops whose writes take a floor-mod by a power of two
// (`v - Math.floor(v / 2^n) * 2^n`) or multiply by one: negative and zero
// values, exponents 0, 52 and above, literal powers, both factor orders,
// fractional values and results past 2^53, which leave the integer copy.

function trim(value: number, bits: number): number {
  return value - Math.floor(value / Math.pow(2, bits)) * Math.pow(2, bits);
}

function low3(value: number): number {
  return value - Math.floor(value / 8) * 8;
}

function rolling(bytes: Uint8Array, bits: number): number {
  let key = 0;
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) {
    key = trim(key, bits) * 4 + bytes[i]!;
    sum = (sum + key) % 1000003;
  }
  return key * 7 + sum;
}

function stepped(start: number, step: number, bits: number, count: number): number {
  let v = start;
  let h = 0;
  for (let i = 0; i < count; i++) {
    v = trim(v, bits) * 3 - step;
    h = (h * 31 + v) % 999983;
  }
  return h * 1000 + v;
}

function literal(start: number, count: number): number {
  let v = start;
  let h = 0;
  for (let i = 0; i < count; i++) {
    v = low3(v) * 16 - i;
    h = (h * 17 + v) % 65521;
  }
  return h * 100 + v;
}

function scaled(start: number, bits: number, count: number): number {
  let v = start;
  let h = 0;
  for (let i = 0; i < count; i++) {
    v = Math.pow(2, bits) * v + 1;
    h = (h * 7 + v) % 10007;
  }
  return h + v;
}

function shifted(start: number, count: number): number {
  let v = start;
  let h = 0;
  for (let i = 0; i < count; i++) {
    v = v * 1024 - i;
    h = (h * 3 + v) % 101;
  }
  return h + v;
}

const bytes = new Uint8Array(4000);
for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + (i >> 3)) & 3;

for (const bits of [0, 1, 2, 10, 22, 34, 50, 52, 53, 60]) console.log("rolling", bits, rolling(bytes, bits));
for (const [start, step, bits] of [
  [0, 1, 3],
  [-5, 3, 2],
  [-1, -1, 0],
  [123456789, 7, 20],
  [-9007199254740991, 1, 52],
  [2.5, 1, 4],
  [7, 0.5, 3],
] as const)
  console.log("stepped", start, step, bits, stepped(start, step, bits, 50));
for (const start of [0, 13, -13, 4096, -7.25]) console.log("literal", start, literal(start, 40));
for (const [start, bits] of [
  [1, 3],
  [-2, 5],
  [0, 52],
  [3, 20],
  [-1, 0],
] as const)
  console.log("scaled", start, bits, scaled(start, bits, 6));
for (const start of [0, 1, -1, 3, 1e6]) console.log("shifted", start, shifted(start, 7));
console.log(Object.is(stepped(0, 0, 3, 5), 0), Object.is(scaled(0, 2, 3), 21 + 1));
