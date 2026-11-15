// @requires-libnode
// ES-module island packages that import members of `node:process` by name.
// Node fills the namespace of a builtin once, with copies of the members'
// values, so no accessor sees a later module read `pid`: the import is the
// read. The build's load recorder took the first module that imported
// `node:process` to have read everything (it stayed eager) and the second
// to have read nothing: its `pid` was the build's, as a constant. A module
// that imports only what every run agrees on still waits, when it comes
// before the one that reads `pid`: Node is running after that one.
import { system } from "first-kit";
import { id, parentId } from "second-kit";
import { lines, system as again } from "third-kit";

console.log("first:", system);
console.log("second:", id === process.pid, parentId === process.ppid);
console.log("third:", lines, again);
