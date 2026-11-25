// spawnSync's result carries Node's `pid`: the child's id, a positive
// integer once it ran — also after it exited — and 0 when the spawn itself
// failed.
const childProcess = require("node:child_process");

const ran = childProcess.spawnSync("sh", ["-c", "exit 3"]);
console.log("ran", typeof ran.pid, Number.isInteger(ran.pid), ran.pid > 0, ran.status);

const missing = childProcess.spawnSync("nonexistent-cmd-xyz");
console.log("missing", missing.pid, missing.status, missing.error && missing.error.code);

const captured = childProcess.spawnSync("echo", ["x"], { encoding: "utf8" });
console.log("captured", captured.pid > 0, JSON.stringify(captured.stdout.trim()));

const killed = childProcess.spawnSync("sh", ["-c", "kill -TERM $$"]);
console.log("killed", killed.pid > 0, killed.status, killed.signal);

// A result reached through an untyped value reads the same member.
function pidOf(result) {
  return result.pid;
}
console.log("through a value", typeof pidOf(ran), pidOf(ran) > 0, pidOf(missing), pidOf(killed) > 0);
