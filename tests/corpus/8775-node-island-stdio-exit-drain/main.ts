// @requires-libnode
// A process.stdout.write replacement installed by island code is still
// called with its stream as the receiver from the 'exit' listeners of both
// sides when the event loop drains and nobody calls process.exit.
import { callSync } from "@scriptc/node";

const original = process.stdout.write;
callSync("./writer.cjs", "install");
process.on("exit", (code) => {
  process.stdout.write("native exit write\n");
  process.stdout.write(`native exit code ${code}\n`);
});
setTimeout(() => console.log("last timer"), 5);
console.log("main done", process.stdout.write !== original);
