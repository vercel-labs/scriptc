// @exit: 3
// @requires-libnode
// process.exit in Node.js ends the whole program with its code, after the
// program's own exit listeners ran.
import { callSync } from "@scriptc/node";

process.on("exit", (code) => {
  console.log("exit listener", code);
});
console.log("before");
callSync("./leave.cjs", "leave", 3);
console.log("not reached");
