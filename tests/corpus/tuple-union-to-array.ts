// A UNION of tuples flowing into an array slot — the `as const` key-table
// shape (`LEGACY_KEY_SEQUENCES[functionKey]`), where TypeScript erases the
// arity for free. The width family's copy stance applies to every arm on
// its own tag: a tuple arm rebuilds as a fresh array (%tup.arr), an array
// arm copies or lifts (%arr), and a union arm that is the slot itself keeps
// it. Every read below must byte-match Node.

// The pi shape: an `as const` table indexed by a literal union, its
// readonly-tuple union passed to a `readonly string[]` parameter.
const SEQUENCES = {
  up: ["\x1b[A", "\x1bOA"],
  down: ["\x1b[B", "\x1bOB"],
  home: ["\x1b[H", "\x1bOH", "\x1b[1~", "\x1b[7~"],
  f9: ["\x1b[20~"],
} as const;

type SequenceKey = keyof typeof SEQUENCES;

function matches(data: string, sequences: readonly string[]): boolean {
  return sequences.includes(data);
}

function readKey(key: SequenceKey, data: string): boolean {
  return matches(data, SEQUENCES[key]);
}

console.log(readKey("up", "\x1bOA"), readKey("f9", "\x1b[20~"), readKey("home", "\x1b[9~"));
console.log(SEQUENCES.up.length, SEQUENCES.home.length, SEQUENCES.f9[0]!.length);

// A union of mutable tuples through every flow edge.
type Variant = ["one"] | ["two", "three"] | ["four", "five", "six"];

function pick(flag: number): Variant {
  return flag === 0 ? ["one"] : flag === 1 ? ["two", "three"] : ["four", "five", "six"];
}

function joined(xs: string[]): string {
  return xs.join("-");
}

interface Holder {
  seqs: readonly string[];
  label: string;
}

function holder(flag: number): Holder {
  return { seqs: pick(flag), label: `v${flag}` };
}

function nested(flag: number): string[][] {
  return [pick(flag)];
}

for (let i = 0; i < 3; i++) {
  const variant = pick(i);
  // The union itself has no array members; it becomes one at the slot.
  const asArray: string[] = variant;
  console.log(joined(variant));
  console.log(asArray.length, asArray[asArray.length - 1]!.toUpperCase());
  for (const item of asArray) console.log("item", item);
  const held = holder(i);
  console.log(held.label, held.seqs.length, held.seqs.join("/"));
  console.log(nested(i)[0]!.join("+"));
  // A copy is fresh storage: growing the array leaves the tuple value.
  // Only the array side is observed, where Node agrees byte-for-byte.
  const grown: string[] = variant;
  grown.push("extra", "more");
  console.log(grown.length, grown.join(","));
}

// A record-copy field keeps the union conversion on its own arm.
interface Narrow {
  seqs: Variant;
  label: string;
}
const narrow: Narrow = { seqs: pick(2), label: "n" };
const widened: Holder = narrow;
console.log(widened.label, widened.seqs.length, widened.seqs.join());

// A union of arrays into one wider array slot.
const arrays: string[] | number[] = [1, 2, 3];
const widenedArrays: readonly (string | number)[] = arrays;
console.log(widenedArrays.length, widenedArrays.join(","));

// A missing record key holds undefined; into a `string[]` slot the checked
// conversion throws the catchable TypeError Node raises at the first use.
type Pair = [string, string] | [string];
const table: Record<string, Pair> = { one: ["a", "b"] };
function missingKey(): string[] {
  const present: string[] = table["one"]!;
  console.log("present", present.length, present.join(""));
  try {
    const absent: string[] = table["absent"]!;
    console.log("no throw", absent.length);
  } catch (error) {
    console.log("threw", error instanceof TypeError, (error as Error).name);
  }
  return present;
}
console.log(missingKey().join("|"));

// A narrowed single tuple keeps the existing tuple-to-array path.
const single: ["x", "y"] = ["x", "y"];
const fromSingle: string[] = single;
console.log(fromSingle.length, fromSingle.join(""));

export {};
