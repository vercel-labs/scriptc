// An island promise rejects unhandled: exit 1 with Node's report.
import { callSync } from "@scriptc/node";

process.on("exit", (code) => console.log("native exit listener", code));
callSync("./island.cjs", "rejectLater", 5);
setTimeout(() => console.log("native timer never"), 50);
