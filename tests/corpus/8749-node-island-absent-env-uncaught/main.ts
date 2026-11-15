// @exit: 1
// @requires-libnode
// An error nothing catches, thrown by the first call into a deferred
// island package whose load reads an unset variable the program has set
// since: the module evaluates late inside that call, against the
// environment of its import, and the call's error ends the program.
import { check, mode } from "strict-pkg";

process.on("exit", (code) => console.log("exit listener", code));
console.log("start", typeof check);
process.env.SCRIPTC_ABSENT_ENV_STRICT = "not-a-mode";
console.log("checked", check("on"), mode());
console.log("program's value", process.env.SCRIPTC_ABSENT_ENV_STRICT);
check("maybe");
console.log("not reached");
