// An island timer throws: Node's uncaught report, exit 1, and the program's
// 'exit' listener with the code.
import { callSync } from "@scriptc/node";

process.on("exit", (code) => console.log("native exit listener", code));
callSync("./island.cjs", "throwLater", 5);
setTimeout(() => console.log("native timer never"), 50);
