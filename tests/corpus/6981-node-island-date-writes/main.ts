// @requires-libnode
// A native Date and its object in a Node island are one Date: a setter
// called on either side shows on the other, for every setter, whether the
// island still holds its object from an earlier call or is handed the Date
// again, and whichever way the island calls the setter.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

function fresh(): Date {
  return new Date(1700000000000);
}

// The island writes, the program reads.
const setters: [string, number][] = [
  ["setTime", 5],
  ["setMilliseconds", 7],
  ["setUTCMilliseconds", 7],
  ["setSeconds", 8],
  ["setUTCSeconds", 8],
  ["setMinutes", 9],
  ["setUTCMinutes", 9],
  ["setHours", 3],
  ["setUTCHours", 3],
  ["setDate", 4],
  ["setUTCDate", 4],
  ["setMonth", 2],
  ["setUTCMonth", 2],
  ["setFullYear", 2001],
  ["setUTCFullYear", 2001],
  ["setYear", 99],
  ["setTime", NaN],
];
for (const [setter, value] of setters) {
  const d = fresh();
  const answer: number = lib.call(d, setter, value);
  console.log("island", setter, answer, d.getTime(), d.getTime() === lib.time(d));
}
const uncurried = fresh();
console.log("island, uncurried", lib.uncurried(uncurried, 42), uncurried.getTime());

// The program writes, the island reads: its object from before the write
// (held) and the Date handed over again.
function native(label: string, write: (d: Date) => void): void {
  const d = fresh();
  lib.hold(d);
  write(d);
  console.log("native", label, d.getTime(), lib.heldTime(), lib.time(d), lib.heldText() === String(d));
}
native("setTime", (d) => d.setTime(5));
native("setMilliseconds", (d) => d.setMilliseconds(7));
native("setUTCMilliseconds", (d) => d.setUTCMilliseconds(7));
native("setSeconds", (d) => d.setSeconds(8));
native("setUTCSeconds", (d) => d.setUTCSeconds(8));
native("setMinutes", (d) => d.setMinutes(9));
native("setUTCMinutes", (d) => d.setUTCMinutes(9));
native("setHours", (d) => d.setHours(3));
native("setUTCHours", (d) => d.setUTCHours(3));
native("setDate", (d) => d.setDate(4));
native("setUTCDate", (d) => d.setUTCDate(4));
native("setMonth", (d) => d.setMonth(2));
native("setUTCMonth", (d) => d.setUTCMonth(2));
native("setFullYear", (d) => d.setFullYear(2001));
native("setUTCFullYear", (d) => d.setUTCFullYear(2001));
native("setTime(NaN)", (d) => d.setTime(NaN));

// An invalid Date made valid by the island, and the reverse.
const revived = new Date(NaN);
lib.call(revived, "setTime", 1000);
console.log("revived", revived.getTime(), revived.toISOString());
const broken = fresh();
lib.hold(broken);
broken.setTime(NaN);
console.log("broken", lib.heldText(), lib.heldTime());
