// Indexes that are not proven integers: typed-array reads, inline ASCII
// charCodeAt, local array reads and numeric-keyed lookups decide validity
// with a signed round trip. Every index shape must keep Node's answer.

const odd: number[] = [
  0, -0, 1, 2.5, -1, -0.5, 0.5, 3, 4, 7, 8, 1e-300, 2 ** 31, 2 ** 32, 2 ** 52, 2 ** 53, 2 ** 53 + 2,
  2 ** 63, 2 ** 64, -(2 ** 63), 1e300, -1e300, Infinity, -Infinity, NaN,
];

// Values the compiler cannot see through.
function opaque(values: number[], i: number): number {
  return values[i % values.length]!;
}

class Cursor {
  pos = 0;
  readonly units: Uint16Array;
  readonly bytes: Uint8Array;
  readonly words: Int32Array;
  readonly text: string;
  constructor(text: string) {
    this.text = text;
    this.units = new Uint16Array(text.length);
    for (let i = 0; i < text.length; i++) this.units[i] = text.charCodeAt(i);
    this.bytes = new Uint8Array([1, 2, 3, 250, 255]);
    this.words = new Int32Array([-1, 2147483647, -2147483648, 7]);
  }
  unit(): number {
    return this.units[this.pos];
  }
  byte(): number {
    return this.bytes[this.pos];
  }
  word(): number {
    return this.words[this.pos];
  }
  code(): number {
    return this.text.charCodeAt(this.pos);
  }
  // ToInt32 / ToUint32 of a read that may be missing (NaN -> 0).
  mixed(): number {
    return (this.units[this.pos] ^ 0x5a5a) + (this.bytes[this.pos] | 0) + (this.words[this.pos] >>> 0);
  }
}

const cursor = new Cursor("scriptc!");
const rows: string[] = [];
for (let k = 0; k < odd.length; k++) {
  cursor.pos = opaque(odd, k);
  rows.push(
    [
      String(cursor.pos),
      String(cursor.unit()),
      String(cursor.byte()),
      String(cursor.word()),
      String(cursor.code()),
      String(cursor.mixed()),
    ].join(" "),
  );
}
console.log(rows.join("\n"));

// Local arrays read by an unproven index: holes, out-of-range and fractions.
function arrayReads(index: number): string {
  const values: (string | undefined)[] = ["a", "b", undefined, "d"];
  const numbers = [10, 20, 30];
  return `${values[index]}|${numbers[index]}|${numbers[index] ?? "none"}`;
}
for (let k = 0; k < odd.length; k++) console.log(arrayReads(opaque(odd, k)));

// A non-ASCII string keeps the runtime path for every index.
const wide = "héllo😀";
for (let k = 0; k < odd.length; k++) {
  const i = opaque(odd, k);
  console.log(i, wide.charCodeAt(i), "abc".charCodeAt(i));
}

// Numeric-keyed maps with a dense integer index.
const byIndex = new Map<number, string>();
for (let i = 0; i < 6; i++) byIndex.set(i, `v${i}`);
for (let k = 0; k < odd.length; k++) {
  const key = opaque(odd, k);
  console.log(key, byIndex.get(key) ?? "absent", byIndex.has(key));
}

// A hash over a range whose bounds come from fields.
function rangeHash(chars: Uint16Array, start: number, end: number): number {
  let hash = 0x811c9dc5 | 0;
  for (let i = start; i < end; i++) hash = Math.imul(hash ^ chars[i], 0x01000193);
  return hash ^ (hash >>> 15);
}
console.log(
  rangeHash(cursor.units, 0, 8),
  rangeHash(cursor.units, 2, 12),
  rangeHash(cursor.units, -3, 2),
  rangeHash(cursor.units, 0.5, 4),
  rangeHash(cursor.units, opaque(odd, 1), opaque(odd, 3)),
);
