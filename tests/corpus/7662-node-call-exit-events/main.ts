// @exit: 4
// @requires-libnode
// The program and the Node.js it loads end as one process: Node's
// 'beforeExit' and 'exit' run when the program ends, work that 'beforeExit'
// schedules runs first, and process.exitCode set in Node is the program's.
import { callSync } from "@scriptc/node";

console.log("registered", callSync<boolean>("./listeners.cjs", "register"));
console.log("main done");
