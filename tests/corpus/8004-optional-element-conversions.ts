// `(T | undefined)[]` values built by checked conversions, rest parameters
// and union index reads: nested arrays converted beside their non-optional
// form, a union arm that is an optional-element array, undefined arguments
// and tuple spreads packed into a rest parameter, and an index expression
// that reassigns the receiver.

const plainRows = JSON.parse("[[1, 2], [3]]") as number[][];
console.log(plainRows);
const optionalSource: unknown = (JSON.parse("[[1, null], [null, 4]]") as unknown[][]).map((row) =>
  row.map((v) => (v === null ? undefined : v)),
);
const optionalRows = optionalSource as (number | undefined)[][];
console.log(optionalRows, optionalRows[0]![1], optionalRows[1]!.length);

const armSource: unknown = [1, undefined, 3];
const arm = armSource as (number | undefined)[] | string;
console.log(typeof arm === "string" ? arm : arm.length, arm);
const stringArm = ["a", undefined] as unknown as (string | undefined)[] | number;
console.log(stringArm);
const textArm = "text" as unknown as (string | undefined)[] | string;
console.log(textArm);

function flags(...values: (boolean | undefined)[]): string {
  let text = "";
  for (const value of values) text += value === undefined ? "u" : value ? "t" : "f";
  return `${values.length}:${text}:${String(values[1])}`;
}
console.log(flags(true, undefined));
const flagPair: [boolean, boolean | undefined] = [false, undefined];
console.log(flags(...flagPair), flags(true, ...flagPair), flags(...flagPair, true));
function label(first: string, ...rest: (string | undefined)[]): string {
  return `${first}/${rest.length}/${rest.map((v) => v ?? "-").join("")}`;
}
const words: [string, string | undefined, string | undefined] = ["a", undefined, "c"];
console.log(label(...words), label("b", undefined));
// Spread tuple fields are read before later arguments run.
const changing: [boolean, boolean | undefined] = [true, undefined];
function flip(pair: [boolean, boolean | undefined], second: boolean | undefined): boolean {
  pair[0] = !pair[0];
  pair[1] = second;
  return pair[0];
}
console.log(flags(...changing, flip(changing, true)));
console.log(flags(...changing, flip(changing, undefined), ...changing));
const swapped: [string, string | undefined] = ["x", "y"];
function swap(pair: [string, string | undefined]): string {
  pair[0] = "w";
  pair[1] = undefined;
  return "v";
}
console.log(label("z", ...swapped, swap(swapped), ...swapped));
// Tuple spreads together with array and Set spreads keep undefined
// elements, and every item is read in argument order.
const mixedPair: [boolean, boolean | undefined] = [true, undefined];
const mixedMore: (boolean | undefined)[] = [false, undefined];
console.log(flags(...mixedPair, ...mixedMore), flags(...mixedMore, ...mixedPair), flags(true, ...mixedPair, ...mixedMore, undefined));
const mixedChanging: [boolean, boolean | undefined] = [true, undefined];
console.log(flags(...mixedChanging, ...mixedMore, flip(mixedChanging, true), ...mixedChanging));
const mixedWords: [string, string | undefined] = ["a", undefined];
console.log(label("z", ...["b", undefined, "c"], ...mixedWords), label("y", ...mixedWords, ...new Set(["s", undefined])));
// A tuple returned by a call keeps its string fields alive until every
// field is packed beside the other spreads.
function makeTuple(n: number): [string, string | undefined, string] {
  return ["p" + n.toString(16).repeat(4), n % 2 ? undefined : "q" + n, "r".repeat((n % 7) + 3) + n];
}
for (let i = 0; i < 3; i++) {
  console.log(label("z", ...["m", undefined], ...makeTuple(i), ...mixedWords), label("y", ...makeTuple(i + 10), ...new Set(["s" + i])));
}

function pick(start: (number | undefined)[] | string[], other: (number | undefined)[] | string[]): string {
  let a = start;
  const read = a[((a = other), 0)];
  return `${String(read)} ${String(a[0])}`;
}
console.log(pick([1, undefined, 3], ["x", "y"]), pick([undefined, 2], ["z"]));
function counted(start: (number | undefined)[] | string[]): string {
  let b = start;
  let i = 1;
  const read = b[((b = ["q"]), i--)];
  return `${String(read)} ${b.length} ${i}`;
}
console.log(counted([4, undefined]), counted(["s", "t"]));
