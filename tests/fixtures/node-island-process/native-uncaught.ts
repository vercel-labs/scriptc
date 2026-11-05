// A native timer throws after Node loaded: exit 1, the uncaught report, and
// the island's 'exit' listener with the code.
import { callSync } from "@scriptc/node";

callSync("./island.cjs", "onExit", "a");
callSync("./island.cjs", "timer", 50, "never");
setTimeout(() => {
  console.log("native timer");
  throw new Error("native boom");
}, 5);
