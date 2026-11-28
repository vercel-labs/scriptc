// Element reads carry the type the checker gives them, as tsc and Node do.
// Without noUncheckedIndexedAccess an array, tuple, readonly-array or
// index-signature read is the element type, so a method call on it needs no
// guard, while an out-of-range read still answers undefined at run time.
function attempt(label: string, run: () => unknown): void {
  try {
    console.log(label, "ok", String(run()));
  } catch (error) {
    console.log(label, "threw", (error as Error).name, (error as Error).message);
  }
}

const numbers: number[] = [10, 20, 30];
const i = 1;
console.log("number", numbers[i].toFixed(2), numbers[i].toFixed(), numbers[i].toString(16));
console.log("number locale", numbers[i].toLocaleString());
console.log("number exponential", numbers[i].toExponential(1));
console.log("number own", numbers[i].hasOwnProperty("x"), numbers[i].hasOwnProperty(0));
attempt("number missing method", () => numbers[7].toFixed(2));
attempt("number missing toString", () => numbers[7].toString(16));
attempt("number missing locale", () => numbers[7].toLocaleString());
attempt("number missing own", () => numbers[7].hasOwnProperty("x"));

const words: string[] = ["alpha", "beta"];
console.log("string", words[i].toUpperCase(), words[0].charAt(1), words[i].toString());
attempt("string missing method", () => words[7].toUpperCase());

const tuple: [number, number] = [1.23456, 7.89];
const index: number = 1;
console.log("tuple", tuple[index].toFixed(2), tuple[0].toFixed(3));
console.log(
  "tuple out of range",
  tuple[index + 4] === undefined,
  String(tuple[index + 4]),
  tuple[index + 4] ?? "missing",
);

const readonlyNumbers: readonly number[] = [5.5];
console.log("readonly", readonlyNumbers[0].toFixed(1), readonlyNumbers[1] === undefined);

const bytes = new Uint8Array([3, 4]);
console.log("typed array", bytes[index].toFixed(1), bytes[0].toString(16));
attempt("typed array missing", () => bytes[5].toFixed(1));

const text = "abc";
console.log("string index", text[index].toUpperCase(), text[9] === undefined, text[9] ?? "absent");

const precisions: number[] = [123.456];
console.log("precision", precisions[0].toPrecision(4), precisions[0].toPrecision());

const wordLengths: string[] = ["alpha", "beta"];
console.log("string property", wordLengths[index].length, wordLengths[0].length);
attempt("string property missing", () => wordLengths[7].length);

interface Row {
  amount: number;
  label: string;
}
const rows: Row[] = [{ amount: 2.5, label: "row" }];
console.log("object property", rows[0].amount.toFixed(1), rows[0].label, rows[1] === undefined);
attempt("object property missing", () => rows[1].amount.toFixed(1));

const record: Record<string, number> = { amount: 12.345 };
const key = "amount";
console.log(
  "record",
  record[key].toFixed(2),
  record["missing"] === undefined,
  record["missing"] ?? "none",
);
attempt("record missing method", () => record["missing"].toFixed(2));

const indexSignature: { [name: string]: number } = { total: 9.5 };
console.log("index signature", indexSignature["total"].toString(2));
attempt("index signature missing", () => indexSignature["none"].toFixed(1));

const [head, second] = numbers;
console.log("destructuring", head.toFixed(1), second.toFixed(1));
const { amount } = record;
console.log("record destructuring", amount.toFixed(1));

console.log(
  "optional chaining",
  numbers[i]?.toFixed(2),
  numbers[7]?.toFixed(2),
  numbers[7] ?? "absent",
);
