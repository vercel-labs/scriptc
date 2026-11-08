// @requires-libnode
// Island clearTimeout of an Immediate and clearImmediate of a Timeout clear
// nothing, like Node, even when the program's first timeout and first
// immediate are live together: their handles must not share a number.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
const keptTimeout = setTimeout(() => console.log("timeout kept"), 20);
const keptImmediate = setImmediate(() => console.log("immediate kept"));
lib.clearT(keptImmediate);
lib.clearImm(keptTimeout);
console.log("cleared");

// Each clear function still clears its own kind across the boundary.
lib.clearT(setTimeout(() => console.log("NOT REACHED timeout")));
lib.clearImm(setImmediate(() => console.log("NOT REACHED immediate")));
