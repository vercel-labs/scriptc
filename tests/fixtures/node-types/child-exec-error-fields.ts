// The exec/execFile callback error carries Node's own metadata members:
// `code` is the child's exit status, null after a signal, or the errno
// name ("ENOENT") when the spawn itself failed; `killed` is absent on a
// spawn failure; `signal` is null on an ordinary exit. @types/node types
// `code` as a number; these read the runtime's real values.
import { exec, execFile } from "node:child_process";

function keys(e: unknown): string {
  return Object.keys(e as object).join(",");
}

exec("exit 3", (error) => {
  if (error === null) {
    console.log("exec: no error");
    return;
  }
  console.log("exec exit 3", typeof error.code, error.code, error.killed, error.signal);
  console.log("chain", error?.code, typeof error?.code, error?.killed, error?.signal, error?.cmd);
  console.log("compare", error.code === 3, error.signal === null);
  console.log("cmd", error.cmd, "message", JSON.stringify(error.message));
  console.log("keys", keys(error), "has code", "code" in error);
  // @types/node declares code a number and signal a signal name, but an
  // ordinary failure answers the exit status and a null signal: an
  // inferred binding holds what the read answered, and a presence guard
  // does not turn the value into the declared arm.
  const exitedCode = error.code;
  const exitedSignal = error.signal;
  console.log("locals", typeof exitedCode, exitedCode, typeof exitedSignal, exitedSignal);
  if (error.code !== undefined) console.log("guarded code", error.code, typeof error.code);
  if (error.signal !== undefined) console.log("guarded signal", error.signal, typeof error.signal);
  execFile("/bin/sh", ["-c", "kill -TERM $$"], (signalled) => {
    if (signalled === null) {
      console.log("execFile signal: no error");
      return;
    }
    console.log(
      "execFile signal",
      typeof signalled.code,
      signalled.code,
      signalled.killed,
      signalled.signal,
      keys(signalled),
    );
    const signalledCode = signalled.code;
    const signalledSignal = signalled.signal;
    console.log(
      "execFile signal locals",
      typeof signalledCode,
      signalledCode,
      typeof signalledSignal,
      signalledSignal,
    );
    if (signalled.code !== undefined) console.log("guarded code", signalled.code);
    if (signalled.signal !== undefined) console.log("guarded signal", signalled.signal);
    execFile("/nonexistent-scriptc-probe", [], (missing) => {
      if (missing === null) {
        console.log("execFile ENOENT: no error");
        return;
      }
      console.log(
        "execFile ENOENT",
        typeof missing.code,
        missing.code,
        missing.killed,
        missing.signal,
        keys(missing),
      );
      console.log("errno", missing.errno, "syscall", missing.syscall, "path", missing.path);
      // A spawn failure's `code` is the errno name, not a number: the
      // binding holds the string the read answered.
      const missingCode = missing.code;
      console.log("execFile ENOENT locals", typeof missingCode, missingCode);
    });
  });
});
