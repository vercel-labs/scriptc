// ToInt32 and ToUint32 (`| 0`, `>>> 0`, `^`, `<<`, `>>`) of doubles around
// 2^53 and 2^63, of multiplicative hash products that pass 2^53, and of
// NaN, the infinities and -0.
const values: number[] = [
  2 ** 53 - 1,
  2 ** 53,
  2 ** 53 + 2,
  -(2 ** 53) - 2,
  2 ** 53 * 3 + 4,
  2 ** 62,
  2 ** 62 + 2 ** 40 + 5 * 2 ** 10,
  2 ** 63 - 1024,
  -(2 ** 63) + 1024,
  2 ** 63,
  -(2 ** 63),
  2 ** 63 + 2048,
  2 ** 64,
  2 ** 64 - 2048,
  -(2 ** 64) + 4096,
  2 ** 80 + 2 ** 33,
  1.5e300,
  Infinity,
  -Infinity,
  NaN,
  -0,
  0.75,
  -2.5,
  4294967295.5,
];

function opaque(i: number): number {
  return values[i % values.length]!;
}

for (let i = 0; i < values.length; i++) {
  const v = opaque(i);
  console.log(
    String(v),
    v | 0,
    v >>> 0,
    v ^ 0x5a5a5a5a,
    (v << 3) | 0,
    v >> 7,
    v >>> 9,
  );
}

function fnv(bytes: Uint8Array): number {
  let h = 2166136261;
  for (let i = 0; i < bytes.length; i++) h = ((h ^ bytes[i]!) * 16777619) >>> 0;
  return h;
}

function mix(bytes: Uint8Array): number {
  let h = 0;
  for (let i = 0; i < bytes.length; i++) h = ((h ^ (bytes[i]! - 64)) * 16777619) | 0;
  return h;
}

function poly(bytes: Uint8Array): number {
  let h = 7;
  for (let i = 0; i < bytes.length; i++) h = (h * 1000003 + bytes[i]!) | 0;
  return h;
}

function wide(bytes: Uint8Array): number {
  // Products near 2^63 and past it: the conversion of each must match.
  let h = 3;
  for (let i = 0; i < bytes.length; i++) h = ((h ^ bytes[i]!) * 2147483647 * (bytes[i]! * 17 + 1)) | 0;
  return h;
}

const bytes = new Uint8Array(4096);
let seed = 12345;
for (let i = 0; i < bytes.length; i++) {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  bytes[i] = seed >>> 23;
}
console.log("fnv", fnv(bytes), "mix", mix(bytes), "poly", poly(bytes), "wide", wide(bytes));
