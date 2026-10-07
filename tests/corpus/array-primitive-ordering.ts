// Default ordering compares String conversions and preserves tied values.
const values = [NaN, 2, 10, -0, 0, -0, -1, -10, Infinity, -Infinity, 1e21, 1e-7, 1e20, 1e-6];
const original = values.map(value => String(value)).join(",");
const copied = values.toSorted();
console.log(original === values.map(value => String(value)).join(","), copied !== values);
console.log(copied.map(value => value === 0 ? String(1 / value) : String(value)).join(","));
console.log(values.sort() === values, values.map(value => value === 0 ? String(1 / value) : String(value)).join(","));
console.log([true, false, true, false].sort().join(","));

// Prefixes, embedded NULs, and mismatches within and between UTF-8 units.
const alphabet = ["", "\0", "a\0", "a", "é", "ê", "中", "\ud7ff", "\ue000", "\uffff", "\u{10000}", "\u{10001}", "😀", "😁", "\u{10ffff}"];
for (const prefix of ["", "same-prefix-", "é😀same-prefix-"]) {
  console.log(JSON.stringify(alphabet.map(word => prefix + word).toSorted()));
}
for (const size of [0, 1, 2, 15, 16, 17, 31, 65, 129, 2051]) {
  const words: string[] = [];
  for (let i = 0; i < size; i++) words.push(alphabet[(i * 71) % alphabet.length]!);
  const sorted = words.toSorted();
  console.log(size, JSON.stringify(sorted), JSON.stringify(words.sort()) === JSON.stringify(sorted));
  console.log(JSON.stringify(sorted.toSorted()) === JSON.stringify(sorted));
  console.log(JSON.stringify(sorted.toReversed().sort()) === JSON.stringify(sorted));
}

const holes: string[] = [];
holes[4] = "two";
holes[1] = "one";
holes.fill(undefined as unknown as string, 3, 4);
holes[-1] = "property";
const materialized = holes.toSorted();
console.log(materialized.length, materialized.join("|"), materialized.map((_, index) => index).join(","));
console.log(holes.sort() === holes, holes.join("|"), holes.map((_, index) => index).join(","), holes[-1]);

const sparse: number[] = [];
sparse[1048581] = -0;
sparse[10] = 0;
sparse[3] = 2;
sparse[1] = 10;
sparse.fill(undefined as unknown as number, 1048580, 1048581);
sparse[-1] = 77;
sparse.sort();
console.log(sparse.length, sparse.slice(0, 6).map((_, index) => index).join(","), sparse[-1]);
console.log(sparse.slice(0, 4).map(value => value === 0 ? 1 / value : value).join(","));
console.log(Object.hasOwn(sparse, 4), Object.hasOwn(sparse, 5), Object.hasOwn(sparse, 1048581));

// An explicit effectful comparator still uses its ordinary callback path.
let comparisons = 0;
const callback = [3, 1, 2].toSorted((a, b) => { comparisons++; return a - b; });
console.log(callback.join(","), comparisons > 0);

let receiver = [3, 2, 1];
const saved = receiver;
const order: string[] = [];
function getReceiver(): number[] { order.push("receiver"); return receiver; }
function defaultOrder(): number {
  order.push("argument");
  receiver[0] = 10;
  receiver = [9, 8];
  return 0;
}
console.log(getReceiver().toSorted(void defaultOrder()).join(","), saved.join(","), receiver.join(","), order.join(","));
console.log(receiver.sort(undefined).join(","));
// An erased assertion cannot replace a real comparator with default order.
console.log([2, 10, 1].toSorted(((a: number, b: number) => a - b) as unknown as undefined).join(","));
function fail(): number { throw new Error("argument failed"); }
const untouched = [2, 10, 1];
try { untouched.sort(void fail()); } catch (error) { console.log(error instanceof Error, untouched.join(",")); }
