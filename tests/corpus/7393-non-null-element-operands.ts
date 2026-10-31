// Non-null assertions on array element reads whose index is out of bounds
// or names a hole, used as operands of operators that convert them. `!`
// performs no runtime check, so the read is undefined, as in Node: NaN in
// arithmetic, false in comparisons, "undefined" in strings.

const values = [3, 1, 4, 1, 5];
const words = ["alpha", "beta"];
const flags = [true, false];
const holey: number[] = [];
holey[3] = 7;

function show(v: unknown): string {
  return Object.is(v, -0) ? "-0" : String(v);
}

function line(label: string, parts: unknown[]): void {
  console.log(label.padEnd(10), parts.map(show).join(" "));
}

for (const k of [0, 4, 5, -1, 1.5, 100]) {
  line(`k=${k}`, [
    values[k]! + 1,
    values[k]! * 2,
    -values[k]!,
    values[k]! | 0,
    values[k]! < 3,
    values[k]! >= 1,
    values[k]! === 1,
    values[k]! !== 1,
    `${values[k]!}`,
    "v=" + values[k]!,
    Math.max(values[k]!, 0),
    words[k]! + "!",
    `<${words[k]!}>`,
    words[k]! < "b",
    !flags[k]!,
  ]);
}

line("holes", [holey[0]! + 1, holey[3]! + 1, `${holey[1]!}`, holey[2]! === undefined, holey[9]! > 0]);

// `+` with an untyped partner concatenates or adds when it runs.
const untypedText: any = "x";
const untypedNumber: any = 5;
for (const k of [1, 9]) {
  line(`untyped ${k}`, [
    values[k]! + untypedText,
    untypedText + values[k]!,
    values[k]! + untypedNumber,
    words[k]! + untypedNumber,
    words[k]! + untypedText,
  ]);
}

let sum = 0;
let text = "";
for (let i = 0; i <= values.length; i++) {
  sum += values[i]!;
  text += words[i % 3]!;
  text += ",";
}
line("compound", [sum, text]);

// A counter array: an index past the end reads NaN, and the store widens
// the array to doubles.
function counter(n: number, m: number): number[] {
  const a = new Array(n).fill(0) as number[];
  for (let i = 0; i < 6000; i++) a[i % m] = a[i % m]! + 1;
  return [a[0]!, a[m - 1]!, a.length, a[n + 1]! + 0];
}
line("counter", counter(5000, 5000));
line("past", counter(5000, 5003));
line("zero", counter(4, 0));

const grid = [
  [1, 2],
  [3, 4],
];
let total = 0;
for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) total += grid[r % 2]![c]! * 1;
line("grid", [total]);
