// @requires-libnode
// @env: SCRIPTC_ABSENT_ENV_DEBUG=1,SCRIPTC_ABSENT_ENV_LEVEL=warn
// The package of 8745, in a run that sets two of the variables its load
// reads. The build recorded them as unset, so the boot guard fails and
// the module evaluates at its import, with the run's values, as in Node.
import { DEBUG, describe, Logger, TRACED, VERSION } from "quiet-pkg";

console.log("start");
console.log(typeof describe, describe.name, describe.length);
console.log("constants", VERSION, DEBUG, TRACED);
// A change after the import is not the module's: it already evaluated.
process.env.SCRIPTC_ABSENT_ENV_LEVEL = "error";
delete process.env.SCRIPTC_ABSENT_ENV_DEBUG;
console.log(describe("run"));
console.log(new Logger("main").line("hello"));
console.log("end");
