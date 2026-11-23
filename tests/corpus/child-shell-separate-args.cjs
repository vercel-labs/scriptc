// @normalize-pid
// A shell form with separate arguments concatenates the file and its
// arguments into one command line with single spaces, hands it to the
// shell's -c, and reports Node's DEP0190 once per process; an empty
// argument list keeps the command string as written.
const childProcess = require("node:child_process");

childProcess.execFile("echo", ["a b", "c"], { shell: true }, (error, stdout) => {
  console.log("execFile", error, JSON.stringify(stdout));

  const spawned = childProcess.spawn("echo", ["p q", "r"], { shell: true });
  console.log("spawnfile", JSON.stringify(spawned.spawnfile), JSON.stringify(spawned.spawnargs));
  spawned.stdout.on("data", (chunk) => console.log("spawn", JSON.stringify(String(chunk))));

  spawned.on("close", () => {
    const captured = childProcess.spawnSync("echo", ["s t"], { shell: true, encoding: "utf8" });
    console.log("spawnSync", captured.status, JSON.stringify(captured.stdout));

    const empty = childProcess.spawnSync("echo hi | tr i I", [], { shell: true, encoding: "utf8" });
    console.log("empty", empty.status, JSON.stringify(empty.stdout));
  });
});
