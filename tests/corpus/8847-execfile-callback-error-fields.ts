// execFile's callback error carries Node's own metadata members: code (the
// exit status, null after a signal, or the errno name when the spawn
// itself failed), killed, signal and cmd. A numeric exit status must not
// read undefined, and a spawn failure adds the errnoException fields.
import { execFile } from "node:child_process";

function keys(e: unknown): string {
  return Object.keys(e as object).join(",");
}

execFile("/bin/sh", ["-c", "echo out; echo err 1>&2; exit 3"], (error, stdout, stderr) => {
  if (error === null) {
    console.log("exit 3: no error");
    return;
  }
  console.log("exit 3", typeof error.code, error.code, error.killed, error.signal);
  console.log("cmd", error.cmd, "message", JSON.stringify(error.message));
  console.log("keys", keys(error), "has code", "code" in error);
  console.log("stdout", JSON.stringify(stdout), "stderr", JSON.stringify(stderr));
  execFile("/bin/sh", ["-c", "kill -TERM $$"], (signalled) => {
    if (signalled === null) {
      console.log("signal: no error");
      return;
    }
    console.log(
      "signal",
      typeof signalled.code,
      signalled.code,
      signalled.killed,
      signalled.signal,
      keys(signalled),
    );
    console.log("message", JSON.stringify(signalled.message));
    execFile("/nonexistent-scriptc-probe-xyz", [], (missing) => {
      if (missing === null) {
        console.log("ENOENT: no error");
        return;
      }
      console.log(
        "ENOENT",
        typeof missing.code,
        missing.code,
        missing.killed,
        missing.signal,
        keys(missing),
      );
      console.log("errno", missing.errno, "syscall", missing.syscall, "path", missing.path);
      console.log("message", JSON.stringify(missing.message));
    });
  });
});
