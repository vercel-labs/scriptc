// @normalize-pid
// A shell form validates the file (cannot be empty, no null bytes) and each
// argument (no null bytes) BEFORE it joins them, so an empty file is Node's
// ERR_INVALID_ARG_VALUE and never a command built from the arguments.
const childProcess = require("node:child_process");

const attempt = (label, run) => {
  try {
    const result = run();
    console.log(label, "ok", typeof result);
  } catch (error) {
    console.log(label, error.code, JSON.stringify(error.message));
  }
};

attempt("execFile empty", () => childProcess.execFile("", ["echo", "hi"], { shell: true }, () => {}));
attempt("spawn empty", () => childProcess.spawn("", ["echo", "hi"], { shell: true }));
attempt("spawnSync empty", () =>
  childProcess.spawnSync("", ["echo", "hi"], { shell: true, encoding: "utf8" }),
);
attempt("execFile null-byte arg", () => childProcess.execFile("echo", ["a\0b"], { shell: true }, () => {}));
attempt("execFile null-byte file", () =>
  childProcess.execFile("ec\0ho", ["a"], { shell: true }, () => {}),
);

childProcess.execFile("echo", ["a b"], { shell: true }, (error, stdout) => {
  console.log("runs", error, JSON.stringify(stdout));
});
