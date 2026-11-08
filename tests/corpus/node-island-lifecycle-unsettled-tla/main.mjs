// @exit: 13
// @requires-libnode
// A top-level await on an island promise that never settles: the loop runs
// dry and the process exits with status 13.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
console.log("before");
process.on("exit", (code) => console.log(`exit ${code}`));
await lib.never();
console.log("NOT REACHED");
