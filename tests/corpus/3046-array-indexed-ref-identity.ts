type Item = { label: string };

const fillValue: Item = { label: "same" };
const filled: Item[] = [{ label: "first" }, { label: "second" }, { label: "third" }];
console.log("fill-return", filled.fill(fillValue, 1) === filled);
fillValue.label = "updated";
console.log("fill-shared", JSON.stringify(filled));

const source: Item = { label: "first" };
const copied: Item[] = [source, { label: "second" }, { label: "third" }];
console.log("copy-return", copied.copyWithin(1, 0, 2) === copied);
source.label = "updated";
console.log("copy-shared", JSON.stringify(copied));
