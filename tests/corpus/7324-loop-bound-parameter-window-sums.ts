// Sliding-window sums whose length and width are number parameters read
// from JSON, so no caller proves them int32s: int32 sizes run the
// function's int32 version, and a fractional width, a length past the
// int32 range, -0 and NaN run its ordinary body.

function windowSums(n: number, width: number, values: number[], out: number[]): number {
  let total = 0;
  for (let i = 0; i + width <= n; i++) {
    let s = 0;
    for (let k = 0; k < width; k++) s += values[i + k]!;
    out[i] = s;
    total += s;
  }
  return total;
}

const values: number[] = [];
for (let i = 0; i < 4000; i++) values.push((i * 37) % 101);

const runs = JSON.parse(
  "[[4000, 64, 3], [4000, 1, 2], [100, 2.5, 2], [10, 0, 1], [-0, 3, 1], [4000, 3000000000, 1], [3000000000, 4, 1], [12, 20, 1]]",
) as [number, number, number][];
runs.push([NaN, 2, 1], [Number("250"), Number("8"), 2]);
for (const [n, width, rounds] of runs) {
  const out: number[] = [];
  const length = Math.min(Number.isFinite(n) ? n : 0, 4000);
  for (let i = 0; i < length; i++) out.push(0);
  let total = 0;
  // A length past the values reads holes: keep that run within them.
  const limit = n > 4000 ? 4000 : n;
  for (let r = 0; r < rounds; r++) total += windowSums(limit, width, values, out);
  console.log(`${n} ${width} ${rounds}:`, total, out.length, out.slice(0, 3).join(","));
}
