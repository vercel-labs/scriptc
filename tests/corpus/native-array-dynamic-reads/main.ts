// Native arrays and iterators from typed code, read by untyped code: for-of
// over them, their length, an iterator's next read as a value and called,
// generators and async generators beside them, and an array whose
// iteration a Symbol.iterator use elsewhere in the program does not change.
import { asyncKinds, describe, lengths, sumAll, stepper } from "./reads.js";

interface Item {
  sku: string;
  qty: number;
}
const numbers: number[] = [1, 2, 3, 4];
const items: Item[] = [
  { sku: "a", qty: 2 },
  { sku: "b", qty: 5 },
];
const empty: string[] = [];
function* counting(): Generator<number> {
  yield 10;
  yield 20;
}
console.log(sumAll(numbers), sumAll(items.map((i) => i.qty)), sumAll(empty.map(Number)));
console.log(lengths([numbers, items, empty]).join());
numbers.push(5);
console.log(lengths([numbers]).join(), sumAll(numbers));
console.log(describe(items), describe(counting()));
console.log(stepper(numbers).join(), stepper(counting()).join());
const iterable = { *[Symbol.iterator]() { yield "own"; } };
console.log([...iterable].join(), sumAll(numbers));
async function* later(): AsyncGenerator<number> {
  yield 1;
}
asyncKinds(later(), numbers).then((kinds) => console.log(kinds.join()));
