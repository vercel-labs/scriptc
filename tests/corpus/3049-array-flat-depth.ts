const sparse = [1, , 3];
const copied = sparse.flat(0);
console.log(JSON.stringify(copied), copied.length, 1 in copied, 1 in sparse);

const rows = [[1, , 3], , [4, 5]] as number[][];
const one = rows.flat();
console.log(JSON.stringify(one), one.length, 1 in one);

const nested = [[[1], [2, , 3]], [[4]]];
console.log(JSON.stringify(nested.flat()));
console.log(JSON.stringify(nested.flat(2)));
console.log(JSON.stringify(nested.flat(Infinity)));
console.log(JSON.stringify(nested.flat(0)));
console.log(JSON.stringify(nested.flat(-2)));

const first = { value: 1 };
const second = { value: 2 };
const records = [[first], [second]];
const flattened = records.flat();
console.log(flattened[0] === first, flattened[1] === second, records[0]![0] === first);

const words = [["a", "b"], ["c"]];
console.log(words.flat().join("|"), words.flat(0).length);
console.log(JSON.stringify([7, , 9].flat()), JSON.stringify([7, , 9]));

const scalar = [1, , 3] as number[];
function depthArg(value: number): number { console.log("depth", value); return value; }
console.log(JSON.stringify(scalar.flat(depthArg(5))), JSON.stringify(scalar.flat(depthArg(-1))));
