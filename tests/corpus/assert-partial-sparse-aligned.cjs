// partialDeepStrictEqual over sparse arrays: Node matches the expected
// array's own index values, in order, against the actual array's own
// values — an expected hole imposes nothing and an actual hole is not a
// value to match.
const assert = require("node:assert");
function check(name, f) {
  try {
    f();
    console.log(name, "pass");
  } catch (e) {
    console.log(name, "throw", e.name);
  }
}
function holes(count) {
  return new Array(count);
}
function sparseA() {
  const a = [];
  a.length = 2;
  a[1] = undefined;
  return a;
}
function sparseB() {
  const b = [undefined];
  b.length = 2;
  return b;
}
check("Array1VsUndef", () => assert.partialDeepStrictEqual(holes(1), [undefined]));
check("mirrored", () => assert.partialDeepStrictEqual(sparseA(), sparseB()));
check("holeVsValue", () => {
  const a = [];
  a.length = 2;
  a[1] = 1;
  assert.partialDeepStrictEqual(a, [undefined, 1]);
});
check("undefVsArray1", () => assert.partialDeepStrictEqual([undefined], holes(1)));
check("sparseVsShort", () => assert.partialDeepStrictEqual(sparseA(), [undefined]));
check("array2VsUndefs", () => assert.partialDeepStrictEqual(holes(2), [undefined, undefined]));
check("dense", () => assert.partialDeepStrictEqual([1, 2, 3], [1, 3]));
