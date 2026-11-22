// A child closes its stdout while it keeps running, then exits with a code.
// The stream ends at the close and the child's own 'close' waits for the
// process: 'exit' with the code comes before 'close' with the same code.
import { spawn } from "node:child_process";

const child = spawn("sh", ["-c", "printf hi; exec 1>&-; sleep 0.2; exit 3"], {
  stdio: ["ignore", "pipe", "ignore"],
});
const out = child.stdout;
if (out === null) throw new Error("missing stdout");
out.on("data", (chunk: Buffer) => console.log("data", chunk.toString()));
out.on("end", () => console.log("end"));
out.on("close", () => console.log("streamclose"));
child.on("exit", (code) => console.log("exit", code));
child.on("close", (code) => console.log("close", code));
