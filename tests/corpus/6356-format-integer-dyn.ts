// util.format's %d and %i over checked-dynamic arguments, as Node reads
// them: a bigint prints as `${n}n`, a symbol as NaN, and any other value
// as Number(arg) (%d) or parseInt(String(arg)) (%i).
import { format } from "node:util";
const values: unknown[] = [{}, [5], [1, 2], "12px", " 0x1f", "", null, undefined, true, 3.9, -0, 10n, Symbol("s"), new Date(0), { valueOf: () => 7 }, NaN, "1e3"];
for (const v of values) console.log(format("%d|%i", v, v));
console.log(format("%d and %i", 2n ** 70n, -5n));
const report: unknown = { actual: 3 };
console.log("... actual %d.", (report as { actual: unknown }).actual);
