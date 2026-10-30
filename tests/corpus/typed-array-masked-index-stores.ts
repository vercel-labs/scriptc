// Several typed array accesses in one counted loop share an index that is
// not an affine function of the counter (a masked or remaindered counter).
// The loop versioning analysis records that such an index has no affine
// shape and reads the recorded result again at each later access.
const length = 64;
const bytes = new Uint8Array(length);
const words = new Int32Array(16);
const totals = new Float64Array(16);

for (let i = 0; i < bytes.length; i++) {
  const slot = i & 15;
  words[slot] = words[slot]! + i;
  totals[slot] = totals[slot]! + i * 0.5;
  bytes[i] = slot;
}
console.log(Array.from(words).join(","));
console.log(Array.from(totals).join(","));
console.log(bytes.reduce((sum, value) => sum + value, 0));

const ring = new Uint16Array(8);
const seen = new Uint8Array(8);
for (let i = 0; i < length; i++) {
  const at = i % 8;
  ring[at] = ring[at]! * 3 + i;
  seen[at] = seen[at]! + 1;
}
console.log(Array.from(ring).join(","), Array.from(seen).join(","));

function scatter(source: Uint8Array, mask: number): Uint32Array {
  const out = new Uint32Array(mask + 1);
  const counts = new Uint32Array(mask + 1);
  for (let i = 0; i < source.length; i++) {
    const bucket = (source[i]! + i) & mask;
    out[bucket] = out[bucket]! + source[i]!;
    counts[bucket] = counts[bucket]! + 1;
  }
  for (let i = 0; i < out.length; i++) out[i] = out[i]! * 10 + counts[i]!;
  return out;
}
console.log(Array.from(scatter(bytes, 7)).join(","));
