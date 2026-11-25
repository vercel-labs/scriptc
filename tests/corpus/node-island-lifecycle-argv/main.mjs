// @requires-libnode
// Island code (an argument parser, say) reads the program's arguments from
// process.argv.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
console.log(process.argv.length, process.argv.slice(2).join(" "));
console.log(lib.argc(), lib.argv().join(" "));
