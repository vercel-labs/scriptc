// exec/execFile callbacks a JavaScript source leaves untyped: the values
// Node hands the callback (an Error or null, then strings) reach the
// program's own function with the parameter types it declared.
const { exec, execFile } = require("node:child_process");

function report(name, error, stdout, stderr) {
  console.log(name, error === null ? "ok" : error.code, JSON.stringify(stdout), JSON.stringify(stderr));
}

exec("echo hello", (error, stdout, stderr) => {
  report("exec", error, stdout, stderr);
  exec("exit 3", (failure, out, errOut) => {
    report("exec-fail", failure, out, errOut);
    execFile("echo", ["a", "b"], (fileError, fileOut) => {
      console.log("exec-file", fileError === null, JSON.stringify(fileOut));
    });
  });
});
