// @requires-libnode
// A statically imported Node island package whose load reads environment
// variables that are not set, and that the program never calls. The build
// guards each variable as unset, so the module is deferred without a
// `publicEnv` listing: Node never starts and libnode is never mapped, and
// what the program reads of the package comes from the interface snapshot.
import { existsSync, readFileSync } from "node:fs";
import { DEBUG, describe, Logger, TRACED, VERSION } from "quiet-pkg";

function libnodeMapped(): boolean {
  if (!existsSync("/proc/self/maps")) return false;
  return readFileSync("/proc/self/maps", "utf8").includes("libnode");
}

console.log("start");
console.log(typeof describe, describe.name, describe.length);
console.log(typeof Logger, Logger.name, Logger.length);
console.log("constants", VERSION, DEBUG, TRACED);
// Setting the variables now changes nothing about a module that, under
// Node, evaluated at its import.
process.env.SCRIPTC_ABSENT_ENV_DEBUG = "1";
process.env.SCRIPTC_ABSENT_ENV_TRACE = "1";
console.log("constants after", VERSION, DEBUG, TRACED);
console.log("libnode mapped:", libnodeMapped());
console.log("end");
