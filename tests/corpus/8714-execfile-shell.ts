// execFile's `shell: true`: the command string runs through /bin/sh -c,
// like exec; the callback receives the captured outputs and Node's Error
// for a non-zero exit (message "Command failed: <line>"). The complete
// command goes in the first argument with an empty args list (Node's
// DEP0190 warning covers separate shell arguments, which the compiler
// refuses).
import { execFile } from "node:child_process";

console.log("scheduled");
execFile(
  "echo hello shell",
  [],
  { shell: true, encoding: "utf8" },
  (error: Error | null, stdout: string, stderr: string) => {
    console.log(`ok: ${error === null} ${JSON.stringify(stdout)} ${JSON.stringify(stderr)}`);
    execFile("printf out; printf err >&2", [], { shell: true, encoding: "utf8" }, (second) => {
      console.log(`operators: ${second === null}`);
      execFile(
        "printf partial; exit 4",
        [],
        { shell: true, encoding: "utf8" },
        (failed: Error | null, failedOut: string, failedErr: string) => {
          console.log(`fail: ${failed !== null} ${JSON.stringify(failedOut)}`);
          console.log(`message: ${JSON.stringify(failed === null ? "" : failed.message)}`);
          console.log(`stderr: ${JSON.stringify(failedErr)}`);
        },
      );
    });
  },
);
console.log("returned");
