// Typed-array loops whose index adds a loop-invariant number with no known
// integer range, such as the row base of a matrix-vector product. Rows
// with integer, fractional, negative, -0 and NaN bases, windows at 2^32 and
// beyond, and matrices too short for their last rows, read and write as
// Node does.

function matvec(w: Float32Array, v: Float32Array, out: Float32Array, cols: number): void {
  for (let r = 0; r < out.length; r++) {
    const base = r * cols;
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
    for (let j = 0; j < cols; j += 4) {
      s0 += w[base + j]! * v[j]!;
      s1 += w[base + j + 1]! * v[j + 1]!;
      s2 += w[base + j + 2]! * v[j + 2]!;
      s3 += w[base + j + 3]! * v[j + 3]!;
    }
    out[r] = s0 + s1 + s2 + s3;
  }
}

function rowSums(m: Float64Array, rows: number, cols: number, first: number): number[] {
  const sums: number[] = [];
  for (let r = first; r < first + rows; r++) {
    let s = 0;
    for (let c = 0; c < cols; c++) s += m[r * cols + c]!;
    sums.push(s);
  }
  return sums;
}

function shiftedCopy(src: Int16Array, out: Int16Array, offset: number): void {
  for (let i = 0; i < out.length; i++) out[i] = src[i - offset]! + 1;
}

function window(src: Uint8Array, start: number, k: number): number {
  let s = 0;
  for (let i = 0; i < k; i++) s += src[start + i]! * (i + 1);
  return s;
}

const rows = 6, cols = 8;
const w = new Float32Array(rows * cols);
for (let i = 0; i < w.length; i++) w[i] = ((i * 37) % 23) / 4 - 2;
const v = new Float32Array(cols);
for (let i = 0; i < cols; i++) v[i] = (i % 5) - 1.5;
const out = new Float32Array(rows);
matvec(w, v, out, cols);
console.log("matvec", out.join(","));
const tall = new Float32Array(rows + 2);
matvec(w, v, tall, cols);
console.log("matvec past rows", tall.join(","));
const odd = new Float32Array(3);
matvec(w, v, odd, 6.5);
console.log("matvec fractional cols", odd.join(","));
matvec(w, v, odd, NaN);
console.log("matvec NaN cols", odd.join(","));

const m = new Float64Array(30);
for (let i = 0; i < m.length; i++) m[i] = i * 1.5 - 7;
console.log("rows", rowSums(m, 5, 6, 0).join(","));
console.log("rows from -1", rowSums(m, 3, 6, -1).join(","));
console.log("rows fractional", rowSums(m, 2, 2.5, 1).join(","));
console.log("rows past end", rowSums(m, 3, 6, 4).join(","));
console.log("rows -0 base", rowSums(m, 1, 6, -0).join(","));

const src16 = new Int16Array([10, 20, 30, 40, 50, 60]);
const shifted = new Int16Array(6);
shiftedCopy(src16, shifted, 2);
console.log("shifted", shifted.join(","));
shiftedCopy(src16, shifted, -3);
console.log("shifted back", shifted.join(","));
shiftedCopy(src16, shifted, 0.5);
console.log("shifted half", shifted.join(","));

const bytes = new Uint8Array(40);
for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 29) & 255;
console.log("window", window(bytes, 3, 8), window(bytes, 36, 8), window(bytes, -2, 4));
console.log("window far", window(bytes, 2 ** 32, 3), window(bytes, 2 ** 32 + 1, 3), window(bytes, 2 ** 40, 2), window(bytes, -(2 ** 32), 2));
