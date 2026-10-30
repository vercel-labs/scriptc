// Buffer fill with values of more than one byte, swap16/32/64, and
// toString("utf16le"): pattern lengths that do and do not divide the
// filled range, offsets and ends, patterns that are views of the buffer
// being filled, string encodings, sizes around word and pool boundaries,
// and utf16le text with ASCII runs, other BMP characters, surrogate pairs,
// lone surrogates and an odd last byte.

function show(buf: Uint8Array): string {
  return Buffer.from(buf).toString("hex");
}

const fills: string[] = [];
for (const size of [0, 1, 2, 3, 7, 8, 9, 31, 32, 33]) {
  const buf = Buffer.alloc(size);
  buf.fill("ab");
  fills.push(buf.toString("latin1"));
  buf.fill(Buffer.from([1, 2, 3]));
  fills.push(show(buf));
}
console.log(fills.join(" "));

const ranged = Buffer.alloc(20);
ranged.fill("xyz", 3, 17);
console.log(ranged.toString("latin1").replace(/\0/g, "."));
ranged.fill(Buffer.from("0123456789"), 5);
console.log(ranged.toString("latin1").replace(/\0/g, "."));
ranged.fill("long pattern longer than the range", 2, 6);
console.log(ranged.toString("latin1").replace(/\0/g, "."));
ranged.fill("é中", 0, 11);
console.log(show(ranged));
ranged.fill("6869", 0, 7, "hex");
ranged.fill("aGk=", 10, 15, "base64");
console.log(show(ranged));
ranged.fill("éa", 0, 20, "latin1");
console.log(show(ranged));
ranged.fill("ab", 0, 9, "utf16le");
console.log(show(ranged));

// Patterns that are views of the buffer being filled.
const self = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
self.fill(self.subarray(1, 3));
console.log(show(self));
const later = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
later.fill(later.subarray(6, 9), 2);
console.log(show(later));
const whole = Buffer.from([9, 8, 7, 6]);
whole.fill(whole);
console.log(show(whole));
const typed = new Uint8Array(12);
typed.set([5, 6, 7], 0);
Buffer.from(typed.buffer).fill(typed.subarray(0, 3), 3);
console.log(show(typed));

const big = Buffer.alloc(70001);
big.fill("0123456");
console.log(big.length, big.toString("latin1", 0, 10), big.toString("latin1", 69990), big.toString("latin1", 35000, 35010));
try {
  Buffer.alloc(4).fill(Buffer.alloc(0));
} catch (error) {
  console.log((error as NodeJS.ErrnoException).code);
}
console.log(show(Buffer.alloc(5).fill("")));

// swap16/32/64.
for (const size of [0, 8, 16, 24, 64, 1000]) {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = (i * 37 + 11) & 255;
  const a = Buffer.from(buf).swap16();
  const b = Buffer.from(buf).swap32();
  const c = Buffer.from(buf).swap64();
  console.log(size, show(a.subarray(0, 8)), show(b.subarray(0, 8)), show(c.subarray(0, 8)), show(c.subarray(c.length - 8)), a.swap16().equals(buf));
}
for (const [size, width] of [[3, 16], [6, 32], [12, 64]] as const) {
  try {
    const buf = Buffer.alloc(size);
    if (width === 16) buf.swap16();
    else if (width === 32) buf.swap32();
    else buf.swap64();
  } catch (error) {
    console.log((error as NodeJS.ErrnoException).code, (error as Error).message);
  }
}
const view = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).subarray(1, 9);
view.swap32();
console.log(show(view));

// toString("utf16le").
const texts = [
  "plain ascii text",
  "abcéÿĀ߿ࠀ中￿",
  "ascii run then 中文 and more ascii after it",
  "\u{1F600}\u{10FFFF}a\u{10000}",
  "lone \ud800 high and \udc00 low and \ud83d",
  "x".repeat(4097) + "é" + "y".repeat(3),
];
for (const text of texts) {
  const bytes = Buffer.from(text, "utf16le");
  const back = bytes.toString("utf16le");
  console.log(back === text, back.length, bytes.length, JSON.stringify(back.slice(0, 24)), back.charCodeAt(back.length - 1));
}
const odd = Buffer.from([0x61, 0, 0x62, 0, 0x63]);
console.log(JSON.stringify(odd.toString("utf16le")), odd.toString("utf16le").length);
const pairSplit = Buffer.from([0x3d, 0xd8, 0x00, 0xde, 0x3d, 0xd8]);
const split = pairSplit.toString("utf16le");
console.log(split.length, split.codePointAt(0), split.charCodeAt(2));
const units = Buffer.alloc(40);
for (let i = 0; i < 40; i++) units[i] = (i * 53 + 7) & 255;
const decoded = units.toString("utf16le");
console.log(decoded.length, [...decoded].map((c) => c.codePointAt(0)).join(","));
console.log(units.toString("utf16le", 3, 21).length, units.toString("ucs2", 0, 8) === units.toString("utf16le", 0, 8));
