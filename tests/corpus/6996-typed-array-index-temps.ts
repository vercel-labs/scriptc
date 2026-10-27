// Constant index temps derived from a loop counter (`const j = i * 4`) in
// typed-array loops: as indices and as numbers, in loops whose bounds guard
// passes or fails, nested, captured by closures, read after an await or a
// yield, and in loops whose counter reaches large values.

function gray(px: Uint8Array, out: Uint8Array): void {
  for (let i = 0; i < out.length; i++) {
    const j = i * 4;
    out[i] = (px[j]! * 77 + px[j + 1]! * 150 + px[j + 2]! * 29) >> 8;
  }
}

function interleave(a: Float32Array, b: Float32Array, out: Float32Array): void {
  for (let i = 0; i < a.length; i++) {
    const at = 2 * i;
    out[at] = a[i]!;
    out[at + 1] = b[i]!;
  }
}

function strided(src: Int16Array, out: Int32Array): string {
  const seen: number[] = [];
  for (let i = 0; i < out.length; i++) {
    const at = i * 3 + 2;
    out[i] = src[at]! - src[at - 2]!;
    if (i % 5 === 0) seen.push(at, at / 2, -at, at % 4);
  }
  return seen.join(",");
}

function previous(src: Float64Array, out: Float64Array): string {
  const edges: string[] = [];
  for (let i = 0; i < out.length; i++) {
    const before = i - 1;
    out[i] = src[before]! + 1;
    if (before < 1) edges.push(`${before}:${Object.is(before * 0, -0)}:${1 / (before * 0)}`);
  }
  return edges.join(" ");
}

function rows(cells: Uint32Array, width: number, sums: Float64Array): void {
  for (let r = 0; r < sums.length; r++) {
    const base = r * width;
    let total = 0;
    for (let c = 0; c < width; c++) {
      const at = base + c;
      total += cells[at]!;
    }
    sums[r] = total;
  }
}

function captured(values: Uint8Array): number {
  const readers: (() => number)[] = [];
  for (let i = 0; i < values.length; i++) {
    const at = i * 2;
    readers.push(() => at + values[i]!);
  }
  let sum = 0;
  for (const read of readers) sum += read();
  return sum;
}

function wide(start: number, count: number): string {
  const out: number[] = [];
  for (let i = start; i < start + count; i++) {
    const next = i + 1;
    const twice = i * 2;
    out.push(next, twice, next - i);
  }
  return out.join(",");
}

async function afterAwait(values: Float64Array): Promise<string> {
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const at = i * 2;
    await null;
    out.push(at, values[at] ?? -1);
  }
  return out.join(",");
}

function* acrossYield(values: Int8Array): Generator<number> {
  for (let i = 0; i < values.length; i++) {
    const at = i + 1;
    yield values[i]!;
    yield at * 10 + (values[at] ?? 0);
  }
}

const px = new Uint8Array(64);
for (let i = 0; i < px.length; i++) px[i] = (i * 41 + 7) & 255;
const g = new Uint8Array(16);
gray(px, g);
console.log("gray", g.join(","));
const tall = new Uint8Array(20);
gray(px, tall);
console.log("gray past input", tall.join(","));

const fa = new Float32Array([1.5, -2.25, 3.125, 0.1]);
const fb = new Float32Array([10, 20, 30, 40]);
const pairs = new Float32Array(8);
interleave(fa, fb, pairs);
console.log("interleave", pairs.join(","));
const short = new Float32Array(5);
interleave(fa, fb, short);
console.log("interleave short", short.join(","));

const src16 = new Int16Array(40);
for (let i = 0; i < src16.length; i++) src16[i] = (i * 9973) % 32768 - 16384;
const diff = new Int32Array(12);
console.log("strided", strided(src16, diff), diff.join(","));
const far = new Int32Array(20);
console.log("strided past input", strided(src16, far), far.join(","));

const src64 = new Float64Array([0.5, 1.5, 2.5]);
const shifted = new Float64Array(4);
console.log("previous", previous(src64, shifted), shifted.join(","));

const cells = new Uint32Array(30);
for (let i = 0; i < cells.length; i++) cells[i] = (i * 2654435761) >>> 0;
const sums = new Float64Array(5);
rows(cells, 6, sums);
console.log("rows", sums.join(","));
const partial = new Float64Array(6);
rows(cells, 6, partial);
console.log("rows past input", partial.join(","));

console.log("captured", captured(new Uint8Array([5, 6, 7])));
console.log("wide", wide(2 ** 53 - 4, 3));
console.log("wide negative", wide(-3, 4));
console.log("across yield", [...acrossYield(new Int8Array([3, -4, 5]))].join(","));
afterAwait(new Float64Array([0.25, 1.25, 2.25, 3.25, 4.25])).then((line) => console.log("after await", line));
