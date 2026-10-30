// Loops whose own typed-array accesses run once per pass around nested
// loops that read typed arrays: row stores past the end, reads at NaN,
// negative and fractional rows, rows that read a typed array the nested
// loop writes, and a nested loop that reads the row's own result.
function rowSums(u: Float64Array, out: Float64Array, start: number, end: number): void {
  for (let i = start; i < end; i++) {
    let t = out[i] ?? -1;
    for (let j = 0; j < u.length; j++) t += u[j]! * (i + 1);
    out[i] = t;
  }
}

function scaled(u: Float64Array, scale: Float64Array, out: Float64Array, rows: number): void {
  for (let i = 0; i < rows; i++) {
    const s = scale[i * 2] ?? 0.5;
    for (let j = 0; j < u.length; j++) out[j] = out[j]! + u[j]! * s;
    out[i] = out[i]! - 1;
  }
}

function chained(v: Int32Array, rows: number): number {
  let total = 0;
  for (let i = 0; i < rows; i++) {
    let k = 0;
    while (k < v.length) {
      v[k] = v[k]! + (v[i] ?? 7);
      k++;
    }
    total += v[i + 1] ?? -3;
  }
  return total;
}

const show = (label: string, v: Float64Array | Int32Array): void => {
  const parts: string[] = [];
  for (let k = 0; k < v.length; k++) parts.push(Object.is(v[k], -0) ? "-0" : String(v[k]));
  console.log(label, parts.join(" "));
};

const u = new Float64Array([0.5, -1.25, 3, 7.75]);
for (const [start, end] of [
  [0, 4],
  [0, 7],
  [2, 9],
  [-2, 3],
  [0.5, 3.5],
  [NaN, 3],
  [3, 1],
]) {
  const out = new Float64Array(5).fill(2);
  rowSums(u, out, start!, end!);
  show(`rows ${start} ${end}`, out);
}

for (const rows of [0, 1, 3, 6]) {
  const out = new Float64Array(4).fill(1);
  scaled(u, new Float64Array([2, -1, 0.25, 4, 8]), out, rows);
  show(`scaled ${rows}`, out);
  const same = new Float64Array([1, 2, 3, 4]);
  scaled(same, same, same, rows);
  show(`aliased ${rows}`, same);
}

for (const rows of [0, 2, 4, 9]) {
  const v = new Int32Array([1, -2, 3, 2147483647]);
  const total = chained(v, rows);
  show(`chained ${rows} ${total}`, v);
}
