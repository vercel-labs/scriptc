// util.diff with typed arrays of strings and DiffEntry tuples.
import { diff, type DiffEntry } from "node:util";
const before: string[] = ["alpha", "beta", "gamma", "delta"];
const after: string[] = ["alpha", "gamma", "delta", "epsilon"];
const entries: DiffEntry[] = diff(before, after);
for (const [op, value] of entries) console.log(op === 0 ? " " : op === 1 ? "-" : "+", value);
const counts = { kept: 0, actual: 0, expected: 0 };
for (const entry of diff("abcdef", "azcdxf")) {
  if (entry[0] === 0) counts.kept++;
  else if (entry[0] === 1) counts.actual++;
  else counts.expected++;
}
console.log(counts, diff("x", "x").length);
