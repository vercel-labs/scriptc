// @requires-libnode
// A native Date in a Node island is a Date there: the island's brand
// checks, instanceof, inspection and cloning see one of its own Dates, the
// same Date crosses as the same object every time, and it comes back as
// the program's own Date.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

interface Event {
  name: string;
  when: Date;
}

const when = new Date(1700000000000);
const other = new Date(1700000000000);

for (const line of lib.describe(when)) console.log(line);

// One island object per native Date, in every position it crosses in.
console.log("keep", lib.keep(when), lib.keep(when), lib.keep(other), lib.keep(when));
console.log("weak", lib.remember(when, "first"), lib.remember(when, "second"), lib.remember(other, "x"));
const event: Event = { name: "launch", when };
console.log("in a record", lib.sameMember(event, "when", when), lib.format(event));
const byName = new Map<string, Date>([["launch", when]]);
console.log("in a map", lib.sameEntry(byName, "launch", when));
console.log("a property the island adds", lib.tag(when, "a"), lib.tag(when, "b"), lib.tag(other, "c"));

// Coming back: the program's own Date, never a copy.
const back: Date = lib.back(when);
console.log("back", back === when, back === other, back.getTime());
const kept: Date = lib.kept();
console.log("kept", kept === when);
const wrapped = lib.wrap(other);
const inner: Date = wrapped.when;
const listed: Date = wrapped.list[1];
console.log("wrapped", inner === other, listed === other);

// Values typed loosely cross the same way.
const loose: unknown = new Date(86400000);
console.log("unknown", lib.iso(loose));
const either: Date | string = new Date(172800000);
console.log("union", lib.iso(either));
const invalid = new Date(NaN);
console.log("invalid", lib.text(invalid), lib.time(invalid));
console.log("limits", lib.time(new Date(8.64e15)), lib.time(new Date(-8.64e15)), lib.time(new Date(0)));
