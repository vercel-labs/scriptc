// @requires-libnode
// A native module re-exports an island package's names (`export … from
// "pkg"`): the barrel evaluates the island module at its own position and
// importers of the barrel call the island's exports in Node exactly as a
// direct import does. The names are the island's own values, so two paths
// to one export are the same function.
import { Arr, Num, Str, check } from "./barrel.ts";
import { NumberSchema } from "./barrel2.ts";

const numbers = Arr(Num());
const names = Arr(Str());
console.log(numbers.kind, numbers.describe());
console.log(names.kind, names.describe());

console.log(check(numbers, [1, 2, 3]), check(numbers, [1, "2"]), check(names, ["a"]), check(names, [0]));

const alias = NumberSchema();
console.log(alias.kind, alias.describe(), Num === NumberSchema);
