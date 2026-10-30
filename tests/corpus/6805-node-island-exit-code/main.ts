// @exit: 3
// @requires-libnode
// The exit code island code leaves in process.exitCode is the program's,
// and 'exit' listeners of both sides run in registration order with it.
import { callSync } from "@scriptc/node";

process.on("exit", (code) => console.log("native exit listener 1", code));
callSync("./process.cjs", "onExit", "a");
process.on("exit", (code) => console.log("native exit listener 2", code));
callSync("./process.cjs", "onExit", "b");
setTimeout(() => {
  callSync("./process.cjs", "setExitCode", 3);
  console.log("timer done");
}, 5);
console.log("main done");
