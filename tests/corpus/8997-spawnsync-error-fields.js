// spawnSync's `error` carries Node's uv errnoException fields, not just
// `code`: errno (libuv's code, negative), syscall ("spawnSync <file>"),
// path (the file) and spawnargs (the arguments after it), in Node's key
// order. A timeout kill reports them too, with code ETIMEDOUT.
import { execSync, spawnSync } from "node:child_process";

function report(tag, error) {
  console.log(tag, "message:", JSON.stringify(error.message));
  console.log(tag, "code:", error.code);
  console.log(tag, "errno:", error.errno);
  console.log(tag, "syscall:", JSON.stringify(error.syscall));
  console.log(tag, "path:", JSON.stringify(error.path));
  console.log(tag, "spawnargs:", JSON.stringify(error.spawnargs));
  console.log(tag, "keys:", JSON.stringify(Object.keys(error)));
}

// Spawn failure: ENOENT, with arguments after the file.
const missing = spawnSync("definitely-not-a-binary-xyz", ["-h", "two words"], { encoding: "utf8" });
console.log("missing status:", missing.status, "signal:", missing.signal, "instance:", missing.error instanceof Error);
report("missing", missing.error);

// Spawn failure: EACCES (a directory is not executable).
const denied = spawnSync("/tmp", [], { encoding: "utf8" });
console.log("denied status:", denied.status, "signal:", denied.signal);
report("denied", denied.error);

// A timeout: status null, signal the kill signal, error ETIMEDOUT with the
// same errnoException fields. The child is a single process, so the kill
// closes its pipes and the call returns at the deadline.
const slow = spawnSync("/bin/sleep", ["30"], { encoding: "utf8", timeout: 150 });
console.log("timeout status:", slow.status, "signal:", slow.signal);
report("timeout", slow.error);

// Success and a plain non-zero exit stay error-free.
const ok = spawnSync("/bin/sh", ["-c", "exit 0"], { encoding: "utf8" });
console.log("ok error:", ok.error === undefined, ok.status);
const failed = spawnSync("/bin/sh", ["-c", "exit 3"], { encoding: "utf8" });
console.log("failed error:", failed.error === undefined, failed.status);

// execSync throws: a plain command failure is Node's "Command failed" error
// (status, signal, output, pid, stdout, stderr — no errno fields), and a
// timeout throws the spawnSync ETIMEDOUT errnoException with those sync
// fields and `error` pointing at itself.
function reportThrown(tag, run) {
  try {
    run();
    console.log(tag, "no throw");
  } catch (error) {
    console.log(tag, "message:", JSON.stringify(error.message));
    console.log(tag, "code:", error.code, "errno:", error.errno);
    console.log(tag, "syscall:", JSON.stringify(error.syscall), "path:", JSON.stringify(error.path));
    console.log(tag, "spawnargs:", JSON.stringify(error.spawnargs));
    console.log(tag, "status:", error.status, "signal:", error.signal, "pid:", typeof error.pid);
    console.log(tag, "killed:", error.killed, "self:", error.error === error);
    console.log(tag, "output:", Array.isArray(error.output), error.output && error.output.length);
    console.log(tag, "stdout:", JSON.stringify(error.stdout), "stderr:", JSON.stringify(error.stderr));
    console.log(tag, "keys:", JSON.stringify(Object.keys(error)));
  }
}
reportThrown("exec exit3", () => execSync("/bin/sh -c 'exit 3'", { encoding: "utf8" }));
reportThrown("exec timeout", () => execSync("/bin/sleep 0.5", { encoding: "utf8", timeout: 50 }));
