// A destructuring pattern supplies a positional context for its initializer,
// but an arm that spreads a VARIABLE-length array has a run-time length: the
// literal builds the array it is, and the pattern reads positions from it —
// missing ones answer undefined and extra ones drop, as Node's destructuring
// does. Both arms of the conditional are arrays, so the whole ternary is.
function matrixParts(m: number[], is3d: boolean): string {
  const [a, b, c, d, e, f, p, q, w] = is3d
    ? [m[0], m[1], m[4], m[5], m[12], m[13], m[3], m[7], m[15]]
    : [...m, 0, 0, 1];
  return `${a} ${b} ${c} ${d} ${e} ${f} ${p} ${q} ${w}`;
}
console.log(matrixParts([1, 0, 0, 1, 10, 20], false));
console.log(matrixParts([1, 0, 0, 1, 10, 20], true));

// A module-level pattern target keeps the source's missing-position arm too.
const m = [5];
const [x, y, z] = [...m, 0];
console.log(x, y, z);
