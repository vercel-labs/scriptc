// child_process.exec's callback forms: the command line runs with
// /bin/sh -c, the call returns a live ChildProcess immediately, utf8
// stdout/stderr are captured, and the error-first callback fires after the
// current turn. A non-zero exit (a missing command is the shell's 127)
// reports "Command failed: <command>\n<stderr>".
import { exec } from "node:child_process";
import * as childProcess from "node:child_process";

const child = exec("printf out; printf err >&2", (error, stdout, stderr) => {
  console.log("ok", error === null, JSON.stringify(stdout), JSON.stringify(stderr));
  exec("printf 'a\\nb\\nc\\n' | wc -l", (pipeError, lines) => {
    console.log("pipe", pipeError === null, lines.trim());
    exec(`printf '%s|' "a b" 'c d' e`, { encoding: "utf8", maxBuffer: 1024 * 1024 }, (_, quoted) => {
      console.log("quoting", quoted);
      exec("printf partial; printf failed >&2; exit 3", (failed, failedOut, failedErr) => {
        console.log("fail", failed !== null, JSON.stringify(failedOut), JSON.stringify(failedErr));
        console.log("fail-message", JSON.stringify(failed === null ? "" : failed.message));
        exec("exit 1", (silent) => {
          console.log("silent", JSON.stringify(silent === null ? "" : silent.message));
          exec("scriptc-definitely-not-a-command", (missing, missingOut) => {
            const message = missing === null ? "" : missing.message;
            console.log("missing", missing !== null, JSON.stringify(missingOut));
            console.log("missing-message", message.split("\n")[0]);
            exec("true", () => {
              console.log("zero-parameter callback");
              childProcess.exec("printf namespace", (_, out) => console.log(out));
            });
          });
        });
      });
    });
  });
});

console.log("returned", child.pid !== undefined, child.stdout !== null, child.stderr !== null);
console.log("scheduled");
