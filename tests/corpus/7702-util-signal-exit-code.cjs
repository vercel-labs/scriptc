// util.convertProcessSignalToExitCode: 128 plus the os.constants.signals
// number, aliases included, and ERR_INVALID_ARG_VALUE listing every signal
// name for unknown names, other cases and non-strings.
"use strict";
const util = require("util");
const os = require("os");

for (const v of ["SIGKILL", "SIGTERM", "SIGINT", "SIGHUP", "SIGSYS", "SIGIOT", "nope", "sigint", 9, undefined, null]) {
  try {
    console.log(util.convertProcessSignalToExitCode(v));
  } catch (e) {
    console.log(e.name, e.code, e.message);
  }
}
console.log(Object.keys(os.constants.signals).every((name) => util.convertProcessSignalToExitCode(name) === 128 + os.constants.signals[name]));
const convert = util.convertProcessSignalToExitCode;
console.log(convert("SIGPIPE"), typeof convert);
