// Reads of a table that another module builds at load: through that module's
// one-line accessor from a loop here, and in a loop of the module's own. The
// table's module only computes, so its initializer may run at the first
// read; whatever stands in front of a read then must not cost the loop.
import { at, sum } from "./table.ts";

const rounds = Number(process.argv[2] ?? "1");
const n = rounds * 1_000_000;
let total = 0;
for (let i = 0; i < n; i++) total += at(i);
console.log(total, sum(n));
