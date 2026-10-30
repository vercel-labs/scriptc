// Locals assigned from integer typed-array reads and used as indices, loop
// starts and loop bounds. A read past the end is undefined, written here as
// NaN (`?? NaN`): an index of NaN reads undefined and writes nothing, and a
// loop that starts at NaN never runs. Results must match Node.

// A permutation chain with in-place reversals, as fannkuch-redux does.
function flips(perm: Int32Array): number {
  const pp = new Int32Array(perm.length);
  pp.set(perm);
  let count = 0;
  let p0 = pp[0]!;
  while (pp[p0] !== 0) {
    count++;
    for (let i = 1, j = p0 - 1; i < j; i++, j--) {
      const t = pp[i]!;
      pp[i] = pp[j]!;
      pp[j] = t;
    }
    const t = pp[p0]!;
    pp[p0] = p0;
    p0 = t;
  }
  return count;
}
const perms = [
  [3, 1, 2, 0],
  [2, 0, 3, 1, 4],
  [4, 3, 2, 1, 0],
  [1, 2, 3, 4, 5, 0],
];
console.log("flips", perms.map((p) => flips(Int32Array.from(p))).join(","));

// Indices that leave the array: a value past the end, a negative value, and
// one above 2^31 in a Uint32Array.
const links = new Int32Array([2, 5, -1, 0, 1]);
const seen: string[] = [];
let at = links[0]!;
for (let step = 0; step < 6; step++) {
  const next = links[at] ?? NaN;
  seen.push(`${at}->${next}`);
  links[at] = step;
  at = next;
}
console.log("links", seen.join(" "), links.join(","));

const wide = new Uint32Array([1, 0xfffffff0, 3, 0]);
const hops: number[] = [];
let w = wide[0]!;
for (let step = 0; step < 4; step++) {
  const v = wide[w] ?? NaN;
  hops.push(v);
  w = v;
}
console.log("uint32", hops.join(","), w);

// A loop whose bounds come from reads, one of them past the end.
const bounds = new Uint8Array([5, 2, 9]);
const marks: number[] = [];
for (let k = 0; k < 4; k++) {
  const top = bounds[k] ?? NaN;
  let sum = 0;
  for (let i = 0, j = top - 1; i < j; i++, j--) sum += i * 10 + j;
  for (let i = top - 1; i >= 0; i -= 2) sum += i;
  marks.push(sum);
}
console.log("bounds", marks.join(","));

// Sums and products of read locals used as indices.
const table = new Int16Array([3, -2, 7, 1, 0, 4, 6, 2]);
const picks: string[] = [];
for (let i = 0; i < table.length; i++) {
  const a = table[i]!;
  const b = table[(i + 1) % table.length]!;
  picks.push(`${table[a + b] ?? -100}/${table[a * 2] ?? -100}/${table[b - a] ?? -100}`);
}
console.log("sums", picks.join(" "));

// A float element as an index keeps its double meaning.
const floats = new Float64Array([1.5, 2, 0]);
const out = new Int32Array([10, 20, 30]);
const read: string[] = [];
for (let i = 0; i < floats.length; i++) {
  const f = floats[i]!;
  read.push(String(out[f] ?? -1));
  out[f] = i;
}
console.log("floats", read.join(","), out.join(","));
