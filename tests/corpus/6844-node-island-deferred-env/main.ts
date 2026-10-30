// @requires-libnode
// A deferred island package that reads an environment variable when it
// evaluates (scope-B NI-7b): the build records the key as a boot guard,
// and the late evaluation sees the value the variable had at the import
// position, even though the program changed it before the first use.
import { currentMode } from "env-pkg";

console.log("before", process.env.SCRIPTC_NI7B_MODE ?? "(unset)");
process.env.SCRIPTC_NI7B_MODE = "changed";
console.log("mode", currentMode());
console.log("after", process.env.SCRIPTC_NI7B_MODE);
