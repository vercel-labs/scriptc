// A spawn failure with piped, unread output: the bridged stdout view must
// still reach 'end', and the child's 'close' must follow it. Node reports
// 'error' (ENOENT), then the stream 'end', then 'close' with the negative
// error code.
import { spawn } from "node:child_process";

const child = spawn("scriptc-command-that-does-not-exist-xyz", [], {
  stdio: ["ignore", "pipe", "pipe"],
});
const out = child.stdout;
if (out === null) throw new Error("missing stdout");
out.on("end", () => console.log("end"));
child.on("error", (error: Error & { code?: string }) => console.log("error", error.code));
child.on("exit", (code) => console.log("exit", code));
child.on("close", (code) => console.log("close", code));
