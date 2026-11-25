// @requires-libnode
// Two island packages share a dependency whose top level reads an
// environment variable, and a native module imported between them sets the
// variable. Node evaluated the dependency at the first import, with the
// variable unset. The second package's guard fails, so it loads at its
// import; the first, still deferred, evaluates before it, against the
// environment of its own import, so the dependency sees the variable unset.
import { FIRST_LEVEL, first } from "first-pkg";
import "./set-level.ts";
import { SECOND_LEVEL, second } from "second-pkg";

console.log("constants", FIRST_LEVEL, SECOND_LEVEL);
console.log(first(), second());
console.log("program's value", process.env.SCRIPTC_SHARED_ENV_LEVEL);
