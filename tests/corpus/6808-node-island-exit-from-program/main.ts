// @exit: 6
// @requires-libnode
// The program's process.exit runs the 'exit' listeners island code
// registered, at their position, with its code; pending island work is
// dropped, as is anything the listeners schedule.
import { callSync } from "@scriptc/node";

callSync("./process.cjs", "onExit", "a");
process.on("exit", (code) => console.log("native exit listener", code));
callSync("./process.cjs", "onExit", "b");
callSync("./process.cjs", "pending");
setTimeout(() => {
  console.log("exiting");
  process.exit(6);
}, 5);
