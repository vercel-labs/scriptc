// A require cycle whose partner calls an export of index.js with esbuild's
// `(0, import_index.peek)()` spelling while index is still initializing:
// peek reads a const in its temporal dead zone, so Node throws a
// ReferenceError, and scriptc refuses the cycle.
import { show } from "gtcyclecall";

console.log(show());
