// @requires-libnode
// Two deferred island packages whose loads read variables that are not
// set, and a program that sets those variables between the imports and
// the first use. Each module evaluates late against the environment of
// its import position (the variables unset: strict-pkg would throw on the
// value the program wrote), and the program's values are back afterwards.
import { DEBUG, describe, Logger } from "quiet-pkg";
import { mode, seen } from "strict-pkg";

console.log("start", typeof describe, typeof mode, DEBUG);
process.env.SCRIPTC_ABSENT_ENV_DEBUG = "1";
process.env.SCRIPTC_ABSENT_ENV_LEVEL = "error";
process.env.SCRIPTC_ABSENT_ENV_STRICT = "not-a-mode";
console.log(describe("late"));
console.log(new Logger("main").line("hello"));
console.log("mode", mode(), seen());
console.log(
  "program's values",
  process.env.SCRIPTC_ABSENT_ENV_DEBUG,
  process.env.SCRIPTC_ABSENT_ENV_LEVEL,
  process.env.SCRIPTC_ABSENT_ENV_STRICT,
  process.env.SCRIPTC_ABSENT_ENV_TRACE ?? "(unset)",
);
// The functions read the environment when they are called: the run's.
console.log("now", seen());
delete process.env.SCRIPTC_ABSENT_ENV_STRICT;
console.log("now", seen());
