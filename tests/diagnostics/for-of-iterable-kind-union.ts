// for…of over a union of array types compiles (corpus for-of-array-union.ts):
// every arm runs the array iterator. A union whose arms are iterables of
// different kinds would run a different protocol per arm and stays refused,
// as does `for await` over a union of arrays.
function mixed(flag: boolean): string[] | Set<string> {
  if (flag) return ["a", "b"];
  return new Set(["c"]);
}

function countMixed(flag: boolean): number {
  let count = 0;
  for (const entry of mixed(flag)) count += entry.length;
  return count;
}

function texts(flag: boolean): string[] | string {
  return flag ? ["ab", "c"] : "abc";
}

function countTexts(flag: boolean): number {
  let count = 0;
  for (const entry of texts(flag)) count += entry.length;
  return count;
}

function lists(flag: boolean): number[] | string[] {
  return flag ? [1, 2] : ["a"];
}

async function countAwaited(flag: boolean): Promise<number> {
  let count = 0;
  for await (const entry of lists(flag)) count += typeof entry === "number" ? entry : entry.length;
  return count;
}

console.log(countMixed(true), countTexts(false));
countAwaited(true).then((count) => console.log(count));
