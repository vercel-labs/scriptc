// Holes are skipped by the HasProperty family and visited by value iterators.
// Copying methods materialize holes as present undefined without changing the
// original number[] payload ABI.
const sparse: number[] = [];
sparse[2] = 7;
sparse.length = 4;
function kind(value: number): string {
  return typeof value;
}
const kindAlias = kind;
console.log("map", sparse.map(kindAlias).join("|"));
console.log("flat-scalar", sparse.flatMap((_value, index) => index).join(","));
console.log("find-hole", sparse.findIndex((value) => typeof value === "undefined"));
console.log("find-last-hole", sparse.findLastIndex((value) => typeof value === "undefined"));
console.log("some", sparse.some((value) => typeof value === "undefined"));
console.log("every", sparse.every((value) => typeof value === "number"));

const dense = sparse.toReversed();
console.log("dense-map", dense.map(kindAlias).join("|"));
console.log("dense-some", dense.some((value) => typeof value === "undefined"));
const selected = dense.filter((value) => typeof value === "undefined");
console.log("selected", selected.length, selected.map(kind).join("|"));
const flattened = sparse.flatMap(() => dense);
console.log("flattened", flattened.length, flattened.map(kind).join("|"));
console.log("preserved-inner-holes", dense.flatMap(() => sparse).join(","));

for (const value of sparse) console.log("value", typeof value, value);
for (const [index, value] of sparse.entries()) console.log("entry", index, typeof value, value);
for (const pair of dense.entries()) console.log("pair", pair[0], typeof pair[1], pair[1]);

console.log("reduce", sparse.reduce((acc, value) => acc + value, 3));
console.log("reduce-seed", sparse.reduce((acc, value) => acc + value));
console.log("reduce-right", sparse.reduceRight((acc, value) => acc + value));
console.log("dense-reduce", dense.reduce((acc, value) => acc + value, 0));
const holes: number[] = [];
holes.length = 2;
try {
  console.log(holes.reduce((acc, value) => acc + value));
} catch (error) {
  if (error instanceof Error) console.log("empty-reduce", error.name, error.message);
}

const changed = [1, 2, 3];
changed.find((value, index) => {
  console.log("find-mutation", index, typeof value);
  if (index === 0) changed.length = 1;
  return false;
});
