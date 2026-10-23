// Reads that may miss, stored in a record through shorthand properties: the
// fields hold undefined, so `??` takes their defaults, and a present value
// keeps its own.
function shorthand(t: Uint8Array, xs: number[], i: number): string {
  const b = t[i];
  const n = xs[i];
  const o = { b, n };
  return `${o.b ?? -1} ${o.n ?? -2}`;
}

function nested(t: Float64Array, i: number): number {
  const v = t[i];
  const w = t[i + 1];
  const pair = { v, w, sum: (v ?? 0) + (w ?? 0) };
  return (pair.v ?? 100) + (pair.w ?? 1000) + pair.sum;
}

console.log(shorthand(new Uint8Array([5]), [6], 0), shorthand(new Uint8Array([5]), [6], 3));
console.log(nested(new Float64Array([1.5, 2.5]), 0), nested(new Float64Array([1.5, 2.5]), 1), nested(new Float64Array([1.5]), 4));
