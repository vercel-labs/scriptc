// Unary + on unions of strings, numbers and booleans converts as Number(value)
// does: strings parse with StringToNumber (whitespace, hex, octal and binary
// prefixes, Infinity), booleans become 1 and 0, and numbers keep their value.
function show(label: string, value: number): void {
  console.log(label, Object.is(value, -0) ? "-0" : String(value));
}

function plusTextOrNumber(value: string | number): number {
  return +value;
}

function plusTextOrFlag(value: string | boolean): number {
  return +value;
}

function plusNumberOrFlag(value: number | boolean): number {
  return +value;
}

type Scalar = string | number | boolean;

const texts = ["42", " 0x1F ", "", "  ", "1e3", "-0", "abc", "Infinity", "0b101", "0o17", "1_000", "\n7\t"];
for (const text of texts) show(`text ${JSON.stringify(text)}`, plusTextOrNumber(text));
for (const n of [9, -0, 0.5, Number.NaN, -Infinity]) show(`number ${String(n)}`, plusTextOrNumber(n));
for (const value of [true, false, "3", "x"]) show(`text or flag ${String(value)}`, plusTextOrFlag(value));
for (const value of [true, false, 2.5]) show(`number or flag ${String(value)}`, plusNumberOrFlag(value));

const scalars: Scalar[] = ["7", 3.5, true, false, "", -0, " 12 "];
let total = 0;
for (const value of scalars) {
  const n = +value;
  total += n;
  show(`scalar ${typeof value} ${JSON.stringify(value)}`, n);
}
show("total", total);

// In expressions: sums, negation and comparisons.
const width: string | number = texts.length > 3 ? "640" : 0;
const ratio: string | number = texts.length > 3 ? 1.5 : "2";
show("sum", +width + +ratio);
show("negated", -+width);
console.log("compare", +width > 600, +ratio === 1.5);

type Level = "1" | "2" | 3;
function plusLevel(level: Level): number {
  return +level;
}
show("level", plusLevel("2") + plusLevel(3));
