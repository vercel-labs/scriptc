// A thrown array reaches the catch binding as the same array: inspection,
// String(), Array.isArray, typed views and mutation see the thrown object,
// including when the thrown value is a union of a record and an array, and
// after a rethrow.
const shared = [1, 2];
try {
  throw shared;
} catch (e) {
  console.log(e === shared, Array.isArray(e), String(e));
  (e as number[]).push(3);
}
console.log(shared);

function pick(k: number): number[] | { a: number } {
  return k ? [k, k * 2] : { a: k };
}
for (const k of [0, 2]) {
  try {
    throw pick(k);
  } catch (e) {
    console.log(e, Array.isArray(e), typeof e);
  }
}

try {
  try {
    throw [7, [8]];
  } catch (e) {
    throw e;
  }
} catch (e) {
  console.log("rethrown", e);
}

const grid: string[][] = [["x"], ["y", "z"]];
try {
  throw grid;
} catch (e) {
  const rows = e as string[][];
  console.log(JSON.stringify(e), rows.length, rows[1]![1]);
}

try {
  throw [] as number[];
} catch (e) {
  console.log(e, String(e) === "", (e as number[]).length);
}

function fail(items: { id: number }[]): never {
  throw items;
}
try {
  fail([{ id: 1 }, { id: 2 }]);
} catch (e) {
  console.log((e as { id: number }[]).map((item) => item.id));
}
