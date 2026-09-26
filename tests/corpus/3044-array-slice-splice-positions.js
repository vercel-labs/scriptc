const source = [10, 20, 30, 40];

console.log("slice", JSON.stringify(source.slice("1", "3")), JSON.stringify(source.slice(true, null)));
console.log("slice-default", JSON.stringify(source.slice()), JSON.stringify(source.slice(undefined, undefined)));
console.log("slice-range", JSON.stringify(source.slice("-2", Infinity)), JSON.stringify(source.slice(NaN, false)));

const sliceOrder = [];
const sliceResult = (() => {
  sliceOrder.push("receiver");
  return source;
})().slice(void sliceOrder.push("start"), void sliceOrder.push("end"));
console.log("slice-effects", JSON.stringify(sliceResult), sliceOrder.join(","));

const selectedStart = source.length === 4 ? "1" : undefined;
const absentStart = source.length === 3 ? "1" : undefined;
console.log("slice-union", JSON.stringify(source.slice(selectedStart)), JSON.stringify(source.slice(absentStart)));

const spliceSource = [10, 20, 30, 40];
console.log("splice-no-args", JSON.stringify(spliceSource.splice()), JSON.stringify(spliceSource));
console.log("splice-one-arg", JSON.stringify(spliceSource.splice("2")), JSON.stringify(spliceSource));
console.log("splice-undefined-count", JSON.stringify(spliceSource.splice("0", undefined)), JSON.stringify(spliceSource));
console.log("splice-undefined-start", JSON.stringify(spliceSource.splice(undefined)), JSON.stringify(spliceSource));

const spliceMore = [10, 20, 30, 40, 50];
console.log("splice-coerce", JSON.stringify(spliceMore.splice(true, "2")), JSON.stringify(spliceMore));
console.log("splice-null", JSON.stringify(spliceMore.splice(null, false)), JSON.stringify(spliceMore));
const selectedCount = source.length === 4 ? "2" : undefined;
const absentCount = source.length === 3 ? "2" : undefined;
const spliceUnion = [10, 20, 30, 40];
console.log("splice-union", JSON.stringify(spliceUnion.splice(1, selectedCount)), JSON.stringify(spliceUnion));
console.log("splice-union-undefined", JSON.stringify(spliceUnion.splice(0, absentCount)), JSON.stringify(spliceUnion));
const spliceOrder = [];
const spliceResult = spliceMore.splice(void spliceOrder.push("start"), void spliceOrder.push("count"));
console.log("splice-effects", JSON.stringify(spliceResult), JSON.stringify(spliceMore), spliceOrder.join(","));

console.log("toSpliced", JSON.stringify(source.toSpliced("1", "2")), JSON.stringify(source.toSpliced(false, true, 99)));
console.log("toSpliced-default", JSON.stringify(source.toSpliced()), JSON.stringify(source.toSpliced("2")));
console.log("toSpliced-undefined", JSON.stringify(source.toSpliced(undefined, undefined, 99)));
console.log("toSpliced-union", JSON.stringify(source.toSpliced(1, selectedCount)), JSON.stringify(source.toSpliced(1, absentCount)));
const copyOrder = [];
const copied = source.toSpliced(void copyOrder.push("start"), void copyOrder.push("count"), (() => {
  copyOrder.push("item");
  return 99;
})());
console.log("toSpliced-effects", JSON.stringify(copied), copyOrder.join(","), JSON.stringify(source));
