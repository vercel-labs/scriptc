// Where a native Date shared with a Node island differs from Node
// (node-island-handles.test.ts pins it; docs: limitations, "Dates and URLs
// shared with islands"). Under Node the two lines read
// "[object Date] true 1700000000000" and "stamp via unknown: [object Date]
// true 1700000000000", and the third reads "1 1".
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

// An instance of a native class that extends Date is not a Date in the
// island: it is refused by name, typed as itself or as anything else.
class Stamp extends Date {
  label(): string {
    return "stamp " + this.getTime();
  }
}
const stamp = new Stamp(1700000000000);
try {
  console.log(lib.describe(stamp));
} catch (error) {
  console.log(String(error));
}
const loose: unknown = stamp;
try {
  console.log("stamp via unknown:", lib.describe(loose));
} catch (error) {
  console.log("stamp via unknown:", String(error));
}

// A property the island adds to its Date stays in the island: the island
// reads it back from the same Date, native code does not see it.
const when = new Date(0);
lib.tag(when);
const any: any = when;
console.log(String(any.tagged), lib.tagged(when));
