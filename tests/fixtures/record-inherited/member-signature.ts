// A dot read of a prototype-named member whose own entry has another
// signature than the member's (tests/harness/record-inherited-member.test.ts).
const plain: Record<string, (x: number) => number> = { double: (x) => x * 2 };
const builtin = plain.toString;
console.log(typeof builtin);
const numeric: Record<string, (x: number) => number> = { toString: (x: number) => x + 1 };
try {
  const own = numeric.toString;
  console.log(typeof own);
} catch (e) {
  console.log(e instanceof TypeError, (e as Error).message);
}
