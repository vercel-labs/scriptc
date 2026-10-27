// Require cycles whose partner stores an export of index.js (in a const,
// or in an object literal) and calls it while index is still
// initializing: the export reads a const in its temporal dead zone, so
// Node throws a ReferenceError, and scriptc refuses both cycles.
import { show } from "gtcyclealias";
import { show as showBox } from "gtcyclebox";

console.log(show(), showBox());
