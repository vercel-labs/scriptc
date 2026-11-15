// @requires-libnode
// The first use of island code happens inside an 'exit' listener: Node
// starts during exit, the call works, and nothing it schedules runs.
import { callSync } from "@scriptc/node";

process.on("exit", (code) => {
  console.log(`exit listener ${code}`);
  console.log(callSync("./lib.cjs", "hello", "from exit"));
  callSync("./lib.cjs", "schedule");
  console.log("exit listener done");
});
setTimeout(() => console.log("timer"), 5);
console.log("main end");
