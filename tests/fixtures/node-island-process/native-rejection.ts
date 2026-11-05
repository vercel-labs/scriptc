// A native promise rejects unhandled after Node loaded: exit 1 with the
// report, the island's 'exit' listener runs.
import { callSync } from "@scriptc/node";

callSync("./island.cjs", "onExit", "a");
setTimeout(() => {
  console.log("native timer");
  void Promise.reject(new Error("native rejected"));
}, 5);
setTimeout(() => console.log("native timer never"), 50);
