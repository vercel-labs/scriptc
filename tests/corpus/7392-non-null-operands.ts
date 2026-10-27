// Non-null assertions on values that still hold undefined or null, used as
// operands of operators that convert them: arithmetic, comparisons, string
// conversion, Math functions, and loose equality with null. `!`
// performs no runtime check, so the operator sees undefined or null and
// converts it as JavaScript does.

interface Settings {
  limit?: number;
  label?: string;
  enabled?: boolean;
  ratio: number | null;
  note?: string | null;
}

const empty: Settings = { ratio: null };
const full: Settings = { limit: 4, label: "abc", enabled: true, ratio: 0.5, note: "n" };
const counts: Record<string, number> = { a: 1, b: 2 };
const sizes = new Map<string, number>([["small", 1]]);
const values = [3, 1, 4];

function show(v: unknown): string {
  return Object.is(v, -0) ? "-0" : String(v);
}

function line(label: string, parts: unknown[]): void {
  console.log(label.padEnd(12), parts.map(show).join(" "));
}

for (const s of [empty, full]) {
  const tag = s === empty ? "empty" : "full";
  line(`${tag} arith`, [
    s.limit! + 1,
    s.limit! - 1,
    s.limit! * 2,
    s.limit! / 2,
    s.limit! % 3,
    s.limit! ** 2,
    -s.limit!,
    +s.limit!,
    s.ratio! + 1,
    s.ratio! * 4,
    -s.ratio!,
    s.limit! - s.ratio!,
  ]);
  line(`${tag} bits`, [s.limit! | 0, s.limit! & 6, s.limit! << 1, s.limit! >>> 0, ~s.limit!, s.ratio! ^ 1]);
  line(`${tag} compare`, [
    s.limit! < 5,
    s.limit! >= 0,
    s.ratio! < 1,
    s.ratio! > -1,
    s.limit! === 4,
    s.limit! !== 4,
    s.ratio! == 0,
    s.label! < "b",
    s.label! >= "a",
    s.label! === "abc",
    s.enabled! === true,
    s.limit! > s.ratio!,
  ]);
  line(`${tag} strings`, [
    `${s.limit!}`,
    `${s.ratio!}`,
    `${s.enabled!}`,
    `[${s.label!}]`,
    `${s.note!}`,
    "n=" + s.limit!,
    s.limit! + "!",
    s.label! + "?",
    "<" + s.note!,
  ]);
  line(`${tag} convert`, [
    Math.round(s.limit!),
    Math.max(s.limit!, 1),
    Math.min(s.ratio!, 1),
    !s.enabled!,
    !s.ratio!,
  ]);
}

line("record", [counts["z"]! + 1, counts["a"]! + 1, counts["z"]! > 0, `${counts["z"]!}`]);
line("map", [sizes.get("large")! * 2, sizes.get("small")! * 2, `${sizes.get("large")!}`]);
line("find", [values.find((v) => v > 9)! + 1, values.find((v) => v > 3)! + 1]);

let total = 0;
let text = "";
let mask = 7;
for (const key of ["a", "b", "c", "a"]) {
  total += counts[key]!;
  text += counts[key]!;
  text += ",";
  mask &= counts[key]!;
}
line("compound", [total, text, mask]);

const tally: Record<string, number> = {};
for (const word of ["x", "y", "x"]) tally[word] = tally[word]! + 1;
line("tally", [tally["x"], tally["y"]]);

type Cell = number | string | null | undefined;
for (const cell of [3, "4", null, undefined] as Cell[]) {
  const m = new Map<string, Cell>([["k", cell]]);
  line("cell", [`${m.get("k")!}`, m.get("k")! === 3, String(m.get("k")!)]);
}

// Loose equality with null tests both unit arms of a value read once.
const optional = new Map<string, number | null>([["one", 1], ["none", null]]);
let reads = 0;
function lookup(key: string): string | null | undefined {
  reads++;
  return key === "a" ? "x" : key === "b" ? null : undefined;
}
for (const key of ["one", "none", "missing"]) {
  line(`loose ${key}`, [optional.get(key)! == null, optional.get(key)! != undefined, optional.get(key)! == 1]);
}
line("loose call", [lookup("a") == null, lookup("b") == null, lookup("c") != null, reads]);

// `+` with an untyped partner concatenates or adds depending on what the
// partner holds when it runs.
const untypedText: any = "x";
const untypedNumber: any = 5;
const untypedObject: any = { toString: () => "obj" };
for (const s of [empty, full]) {
  let joined: any = "t";
  let summed: any = 1;
  joined += s.limit!;
  summed += s.limit!;
  line(`untyped ${s === empty ? "empty" : "full"}`, [
    s.limit! + untypedText,
    untypedText + s.limit!,
    s.limit! + untypedNumber,
    untypedNumber + s.limit!,
    s.label! + untypedText,
    s.limit! + untypedObject,
    joined,
    summed,
  ]);
}
