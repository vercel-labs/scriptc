// Speculative integer loops over typed-array views held by a const local
// and by a parameter. The fast copy, the copy a failed check resumes in and
// the ordinary copy all read and write the same views: a product that
// leaves the safe integers fails the fast copy's check partway through,
// and writes past the end are ignored.
function fill(buffer: ArrayBuffer, count: number, seed: number): number {
  const view = new Float64Array(buffer);
  let l = seed;
  for (let i = 0; i < count; i++) {
    l = (l * 3877 + 29573) % 139968;
    view[i] = l;
  }
  return l;
}

function grow(out: Int32Array, count: number, start: number): number {
  let x = start;
  for (let i = 0; i < count; i++) {
    x = x * 3 + 1;
    out[i] = x % 1000;
  }
  return x;
}

function sum(view: Float64Array | Int32Array): number {
  let s = 0;
  for (const v of view) s += v;
  return s;
}

const buffer = new ArrayBuffer(8 * 64);
console.log(fill(buffer, 64, 42), sum(new Float64Array(buffer)));
console.log(fill(buffer, 100, 7), new Float64Array(buffer)[63]);
const out = new Int32Array(40);
console.log(grow(out, 60, 1), sum(out), out[0], out[39]);
console.log(grow(out, 10, 5), out.join(","));
