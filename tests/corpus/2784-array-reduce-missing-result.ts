const sparse: number[] = [];
sparse[1] = 7;
sparse.length = 4;
const values = sparse.toReversed();
const result = values.reduce((acc, value, index) => {
  console.log("left", index, typeof acc, acc, typeof value, value);
  return value;
}, 99);
console.log("result", typeof result, result);
function choose(acc: number, value: number, index: number): number {
  console.log("right", index, typeof acc, acc, typeof value, value);
  return value;
}
const chooseAlias = choose;
const right = values.reduceRight(chooseAlias, 88);
console.log("right-result", typeof right, right);
const empty: number[] = [];
const seed = empty.reduce((acc, value) => acc + value, 23);
console.log("empty", seed);
const one: number[] = [];
one.length = 1;
const denseOne = one.toReversed();
const only = denseOne.reduce((acc, value) => acc + value);
console.log("only", typeof only, only);
