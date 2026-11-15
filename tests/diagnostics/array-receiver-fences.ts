// What the array methods still refuse on receivers that are not one plain
// array, each by name. A fixed tuple takes reduce, reduceRight, forEach,
// flat and the for-of walks of entries(), keys() and values() (corpus 9431
// to 9433); an array of value-or-array elements takes flat (9433); a union
// of array types takes some, every and findIndex (9435). The forms below
// have no lowering that reads the receiver as the method would.
const sides: [string, string, string] = ["left", "top", "right"];
const rows: [number[], number[]] = [[1], [2]];
const words: (string | string[])[] = ["oak", ["elm"]];
const levels: (number | number[] | number[][])[] = [1, [2], [[3]]];
const optional: (string | string[] | undefined)[] = ["a", undefined, ["b"]];
declare const depth: number;

// A callback that takes the tuple as an array would receive a copy.
function reduceWithArray(): number {
  return sides.reduce((acc, side, index, all) => acc + side.length + index + all.length, 0);
}
function forEachWithArray(): void {
  sides.forEach((side, index, all) => console.log(side, index, all.length));
}
// A depth that is not a literal could run code between the receiver's
// evaluation and the reads of its positions.
function tupleFlatComputedDepth(): number {
  return rows.flat(depth).length;
}
// Elements of three kinds, or of a kind with undefined beside it.
function flatThreeKinds(): number {
  return levels.flat().length;
}
function flatWithUndefined(): number {
  return optional.flat().length;
}
// The checker's result for a depth it cannot read is not the element type.
function flatComputedDepth(): number {
  return words.flat(depth).length;
}
// Iterator objects of a tuple outside a for-of head.
function tupleEntriesValue(): number {
  return [...sides.entries()].length;
}
function tupleKeysValue(): number {
  return Array.from(sides.keys()).length;
}
// Methods a tuple has no in-place lowering for.
function tupleAt(): string | undefined {
  return sides.at(-1);
}
function tupleConcat(): number {
  return sides.concat(["down"]).length;
}
function tupleToSorted(): string {
  return sides.toSorted().join(",");
}
forEachWithArray();
console.log(reduceWithArray());
console.log(tupleFlatComputedDepth());
console.log(flatThreeKinds());
console.log(flatWithUndefined());
console.log(flatComputedDepth());
console.log(tupleEntriesValue());
console.log(tupleKeysValue());
console.log(tupleAt());
console.log(tupleConcat());
console.log(tupleToSorted());
