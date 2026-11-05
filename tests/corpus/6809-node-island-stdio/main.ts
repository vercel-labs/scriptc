// @requires-libnode
// stdout and stderr are the same descriptors on both sides, and every
// write is complete when it returns, so the lines of both sides interleave
// in program order, large writes included.
import { callSync } from "@scriptc/node";

console.log("native log 1");
callSync("./stdio.cjs", "write", "1");
process.stdout.write("native write 1\n");
console.error("native error 1");
callSync("./stdio.cjs", "big", 200000);
process.stdout.write(`${"n".repeat(200000)}\n`);
// The island timer (50 ms) and the native timer (100 ms) are due well
// after this script and the immediates finish, on a loaded host too.
callSync("./stdio.cjs", "later", 50);
setTimeout(() => {
  console.log("native timer log");
  callSync("./stdio.cjs", "write", "2");
  console.error("native timer error");
}, 100);
setImmediate(() => console.log("native immediate log"));
process.on("exit", () => console.log("native exit listener log"));
console.log("native log 2");
