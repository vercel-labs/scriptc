// One package opted in (escape-string-regexp compiles statically), one
// UNTYPED package beside it (typegapped ships no .d.ts and its JS does not
// typecheck under this tsconfig). Compiling the first changes nothing about
// the second: its JavaScript stays out of the checked program and its
// import is reported as in typegap-only.ts.
import escapeStringRegexp from "escape-string-regexp";
import label from "typegapped";

console.log(escapeStringRegexp("1+1"));
console.log(label(3));
