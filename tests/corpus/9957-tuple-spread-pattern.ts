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

// A spread whose positions disagree keeps each value it produces.
const xs: number[] = [1];
const [m1, m2, m3] = [...xs, "x"];
console.log(m1, m2, m3);

// Record positions keep a missing element as undefined too.
function labelOf(item: { label: string } | undefined): string {
  return item === undefined ? "none" : item.label;
}
const emptyItems: { label: string }[] = [];
const [firstItem, secondItem] = [...emptyItems, { label: "b" }];
console.log(labelOf(firstItem), labelOf(secondItem));

// A fixed-tuple spread beside a variable-length one.
const pair: [number, number] = [1, 2];
const rest: number[] = [];
const [p1, p2, p3] = [...pair, ...rest];
console.log(p1, p2, p3);

// A nullable element type survives the spread: null is a value, not absence.
const nullable: ({ label: string } | null)[] = [null, { label: "x" }];
const [n1, n2] = nullable.length > 0 ? [...nullable] : [];
console.log(labelOf(n1 ?? undefined), labelOf(n2 ?? undefined));
