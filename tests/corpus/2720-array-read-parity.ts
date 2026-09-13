// Ordinary dense-array reads keep JavaScript's undefined result at the
// frontend boundary, including when TypeScript does not enable
// noUncheckedIndexedAccess.
const numbers: number[] = [10];
const words: string[] = [];
const refs: { name: string }[] = [{ name: "kept" }];

console.log(`${numbers[1]}`, `${words[0]}`);
console.log("string arithmetic", words[0] + 1, 1 + words[0], words[0] + words[0]);
const storedStringArithmetic = words[3] + 2;
function returnedStringArithmetic(values: string[]): number | string {
  return values[3] + 2;
}
const returnedStringArithmeticValue = returnedStringArithmetic(words);
console.log("stored string arithmetic", typeof storedStringArithmetic, storedStringArithmetic, typeof returnedStringArithmeticValue, returnedStringArithmeticValue);
console.log(numbers[1] ?? 42, words[0] || "missing", refs[1] === undefined);
console.log(numbers[0], words[0], refs[0] === refs[0]);

const numberMissing = numbers[1];
const wordMissing = words[0];
console.log(numberMissing === undefined, wordMissing === undefined);
if (numberMissing === undefined) console.log("number narrowed");
if (!wordMissing) console.log("word narrowed");

const [head, tail] = numbers;
const [firstWord, secondWord] = words;
console.log(head, tail, firstWord, secondWord);

const mutable: string[] = ["first"];
const alias = mutable;
const beforeMutation = mutable[0];
alias.pop();
console.log(beforeMutation ?? "missing", mutable[0] ?? "missing");

console.log(["a", "b"].pop(), [].pop());
console.log(["a", "b"].shift(), [].shift());
const popped: number[] = [];
console.log(popped.pop() ?? "empty", popped.shift() ?? "empty");

let reads = 0;
function take(empty: boolean): number[] {
  reads++;
  return empty ? [] : [4];
}
console.log(take(true)[0] === undefined, reads);
console.log(take(false)[0] + 1, reads);
console.log(take(false)[0] === take(false)[0], reads);

function inspectNumber(value: number): void {
  console.log(typeof value, value, value + 1);
}
function firstNumber(values: number[]): number {
  return values[0];
}
const inspectAlias = inspectNumber;
const firstAlias = firstNumber;
inspectAlias(firstAlias([]));

function firstOrMissing(xs: number[]): number | undefined {
  return xs[0];
}

function show(value: number | undefined): void {
  console.log(value === undefined ? "parameter missing" : value);
}

show(firstOrMissing([]));
show(firstOrMissing([7]));
