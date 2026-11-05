// A mixed tuple/array union (`["one"] | string[]`) in the slots 8513 does
// not cover: read out of an index-signature record, nested inside a
// `string[][]` literal, spread, and in parameter position. Node has one
// array in every one of them, so no arm may trap.
type Mixed = ["one"] | string[];

function store(): Record<string, Mixed> {
  return { a: ["x"], b: ["y", "z"] };
}
const table = store();
const fromRecord: string[] = table["a"]!;
const fromSecond: string[] = table["b"]!;
console.log("record", fromRecord.length, fromRecord[0], fromSecond.join("+"));

function width(values: string[]): number {
  return values.length;
}
const tupleArm: Mixed = ["one"];
const arrayArm: Mixed = ["two", "three"];
console.log("param", width(tupleArm), width(arrayArm));

const nested: string[][] = [tupleArm, arrayArm];
console.log("nested", nested.length, nested[0]!.join("+"), nested[1]!.join("+"));

const spread: string[][] = [...nested, fromSecond, ["tail"]];
console.log("spread", spread.map((v) => v.join("")).join(","));

const readonly: readonly string[] = tupleArm;
console.log("readonly", readonly.length, readonly[0]);

const fromTernary: string[] = Math.random() > 2 ? tupleArm : arrayArm;
console.log("ternary", fromTernary.join(""));
