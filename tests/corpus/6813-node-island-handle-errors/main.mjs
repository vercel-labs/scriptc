// @requires-libnode
// Errors across the island boundary (scope-B NI-4): an island Error caught
// in the program keeps its class, name, message, code and stack, and is the
// same Node object when it crosses back; a program error passed into Node
// becomes a Node error with the same name, message and code.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

for (const kind of ["type", "range", "custom"]) {
  try {
    lib.fail(kind);
  } catch (e) {
    console.log(kind, e instanceof Error, e instanceof TypeError, e instanceof RangeError);
    console.log(" ", e.name, e.message, e.code);
    console.log("  stack head", String(e.stack).split("\n")[0]);
    console.log("  stack has island frame", String(e.stack).includes("lib.cjs"));
    console.log("  same object in Node", lib.isLast(e), lib.inspectError(e));
    try {
      lib.rethrow(e);
    } catch (again) {
      console.log("  rethrown", again === e, again.message);
    }
  }
}

try {
  lib.fail("string");
} catch (e) {
  console.log("string", typeof e, e);
}
try {
  lib.fail("object");
} catch (e) {
  console.log("object", typeof e, e.reason, lib.isLast(e));
}
console.log(lib.fail("none"));

// Program errors crossing into Node.
const mine = new RangeError("from the program");
console.log("native", lib.inspectError(mine));
const coded = new Error("with code");
coded.code = "E_MINE";
console.log("native coded", lib.inspectError(coded));
try {
  lib.rethrow(new TypeError("round trip"));
} catch (e) {
  console.log("round trip", e instanceof TypeError, e.message);
}

// Errors from calling missing members.
try {
  lib.call({}, "nope");
} catch (e) {
  console.log("missing method", e instanceof TypeError, e.message);
}
try {
  lib.nope();
} catch (e) {
  console.log("missing export", e instanceof TypeError, e.message);
}
