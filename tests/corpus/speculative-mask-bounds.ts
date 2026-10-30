// Speculative integer loops whose writes shift and add a value masked to
// its low bits: exponents up to 50 stay in the integer copy, and larger
// ones (51 and 52) keep the value tests, which bail to the double copy
// when a shift or a sum leaves the safe integers.
function trim(value: number, bits: number): number {
  return value - Math.floor(value / Math.pow(2, bits)) * Math.pow(2, bits);
}

function rolling(codes: Uint8Array, bits: number, scale: number): number {
  let key = 2 ** 52 - 7;
  let sum = 0;
  for (let i = 0; i < codes.length; i++) {
    key = trim(key, bits) * 4 + codes[i]!;
    sum = (sum + (key % 1000003)) % 1000000007;
  }
  return sum * scale + (key % 999983);
}

function signedBytes(codes: Int8Array, bits: number): number {
  let key = 12345;
  let sum = 0;
  for (let i = 0; i < codes.length; i++) {
    key = trim(key, bits) * 2 + codes[i]!;
    sum = (sum + (key % 65521)) % 1000000007;
  }
  return sum;
}

function wideWords(words: Uint32Array, bits: number): number {
  let key = 1;
  let sum = 0;
  for (let i = 0; i < words.length; i++) {
    key = trim(key, bits) * 8 + words[i]!;
    sum = (sum + (key % 104729)) % 1000000007;
  }
  return sum;
}

// A read past the end gives undefined, so the sum is NaN from there on.
function pastTheEnd(codes: Uint8Array, bits: number): number {
  let key = 3;
  for (let i = 0; i <= codes.length; i++) key = trim(key, bits) * 4 + codes[i]!;
  return key;
}

const codes = new Uint8Array(4000);
for (let i = 0; i < codes.length; i++) codes[i] = (i * 2654435761) % 256;
const signed = new Int8Array(3000);
for (let i = 0; i < signed.length; i++) signed[i] = ((i * 40503) % 256) - 128;
const words = new Uint32Array(2000);
for (let i = 0; i < words.length; i++) words[i] = (i * 2246822519) % 4294967296;

for (const bits of [0, 1, 22, 34, 49, 50, 51, 52, 53])
  console.log(bits, rolling(codes, bits, 3), signedBytes(signed, bits), wideWords(words, bits));
console.log(pastTheEnd(codes.subarray(0, 10), 20), pastTheEnd(codes.subarray(0, 0), 50));
