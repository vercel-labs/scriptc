// @requires-libnode
// An island package whose evaluation prints is not deferred (scope-B NI-7's
// static effect gate refuses top-level calls): it evaluates at its import
// position, so its output comes before the program's own, as in Node.
import { shout } from "loud-pkg";

console.log("main body");
console.log(shout("done"));
