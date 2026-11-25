// @normalize-pid
// An execFile timeout past 2147483647 is still an unsigned integer: Node's
// Timeout accepts it, warns TimeoutOverflowWarning on a later tick ("...
// does not fit into a 32-bit signed integer.\nTimeout duration was set to
// 1."), sets the deadline to 1ms, and the child takes the SIGTERM default
// there. The warning reaches the default stderr report with its one-time
// --trace-warnings hint.
import { execFile } from "node:child_process";

interface ExecError extends Error {
  killed?: boolean;
  signal?: string | null;
}

console.log("scheduled");

execFile("/bin/sh", ["-c", "sleep 5"], { timeout: 2147483648 }, (error, stdout, stderr) => {
  const e = error as ExecError | null;
  console.log(
    "overflow",
    JSON.stringify({
      failed: e !== null,
      killed: e === null ? null : (e.killed ?? null),
      signal: e === null ? null : (e.signal ?? null),
      message: e === null ? null : e.message,
      stdout,
      stderr,
    }),
  );
});
