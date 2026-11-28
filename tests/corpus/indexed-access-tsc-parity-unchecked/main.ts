// noUncheckedIndexedAccess ON: every array, tuple and index-signature read
// is `T | undefined`, exactly as tsc says, so a value is guarded before it
// is used and an out-of-range read is undefined at run time.
const numbers: number[] = [10, 20, 30];
const i = 1;
console.log("number", numbers[i]?.toFixed(2));
const picked = numbers[i];
if (picked !== undefined) console.log("narrowed", picked.toFixed(2));
console.log(
  "missing",
  numbers[7] === undefined,
  numbers[7] ?? "absent",
  numbers[7]?.toFixed(2),
);

const [head] = numbers;
console.log("destructuring", head === undefined ? "missing" : head.toFixed(1));

const record: Record<string, number> = { amount: 12.345 };
const key = "amount";
const value = record[key];
console.log("record", value === undefined ? "missing" : value.toFixed(2));

const tuple: [number, number] = [1.5, 2.5];
const index: number = 1;
const element = tuple[index];
console.log("tuple", element === undefined ? "missing" : element.toFixed(1));

const words: string[] = ["alpha"];
console.log("string", words[0]?.toUpperCase(), words[3]?.toUpperCase() ?? "absent");

const bytes = new Uint8Array([3, 4]);
console.log("typed array", bytes[i]?.toFixed(1), bytes[5]?.toFixed(1) ?? "absent");

const text = "abc";
console.log("string index", text[i]?.toUpperCase(), text[9]?.toUpperCase() ?? "absent");

const precisions: number[] = [123.456];
console.log("precision", precisions[0]?.toPrecision(4));

const wordLengths: string[] = ["alpha", "beta"];
console.log("string property", wordLengths[i]?.length, wordLengths[0]?.length);

interface Row {
  amount: number;
  label: string;
}
const rows: Row[] = [{ amount: 2.5, label: "row" }];
console.log("object property", rows[0]?.amount?.toFixed(1), rows[i]?.label ?? "absent");
