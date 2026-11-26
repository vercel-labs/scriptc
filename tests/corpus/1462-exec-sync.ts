// child_process.execFileSync / execSync: capture, options (encoding, cwd,
// env, input, stdio, timeout), and Node's exact thrown error messages for
// non-zero exits, spawn failures, and timeouts.
import { execFileSync, execSync } from "node:child_process";

// Plain capture with encoding.
console.log(JSON.stringify(execFileSync("printf", ["a b\nc"], { encoding: "utf8" })));

// execSync runs through /bin/sh.
console.log(JSON.stringify(execSync("echo $((6 * 7))", { encoding: "utf8" })));

// cwd.
console.log("cwd:", execFileSync("pwd", [], { encoding: "utf8", cwd: "/" }));

// env REPLACES the child environment.
console.log("env:", execSync("echo A=$SCRIPTC_A B=$SCRIPTC_TEST_ENV", { encoding: "utf8", env: { SCRIPTC_A: "one" } }));

// input feeds stdin.
console.log("input:", execFileSync("cat", [], { encoding: "utf8", input: "fed to cat" }));

// stdio: "pipe" captures stderr instead of echoing it (nothing on our
// stderr — the harness compares stderr byte-for-byte).
const quiet = execFileSync("sh", ["-c", "echo out; echo quiet-err 1>&2"], { encoding: "utf8", stdio: "pipe" });
console.log("quiet:", JSON.stringify(quiet));

// Array stdio: ignore stderr entirely.
const ignored = execFileSync("sh", ["-c", "echo kept; echo dropped 1>&2"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
console.log("ignored:", JSON.stringify(ignored));

// Default stdio echoes the child's captured stderr to OUR stderr after the
// child exits — Node does the same (both lanes must agree byte-for-byte).
console.log("echo:", JSON.stringify(execSync("echo visible-err 1>&2; echo out-part", { encoding: "utf8" })));

// Non-zero exit: Error with Node's message (command + captured stderr).
try {
  execFileSync("sh", ["-c", "echo some-out; echo the-failure 1>&2; exit 3"], { encoding: "utf8", stdio: "pipe" });
} catch (e) {
  console.log("fail:", e instanceof Error ? e.message : "?");
}
try {
  execSync("exit 7", { encoding: "utf8", stdio: "pipe" });
} catch (e) {
  console.log("fail2:", e instanceof Error ? e.message : "?");
}

// Spawn failure: ENOENT with Node's spawnSync message.
try {
  execFileSync("definitely-not-a-command-xyz", ["a"], { encoding: "utf8", stdio: "pipe" });
} catch (e) {
  console.log("enoent:", e instanceof Error ? e.message : "?");
}

// Timeout: the child is killed and the ETIMEDOUT error throws.
try {
  execFileSync("sleep", ["5"], { encoding: "utf8", timeout: 150, stdio: "pipe" });
} catch (e) {
  console.log("timeout:", e instanceof Error ? e.message : "?");
}

// Statement position without encoding (Node would hand back a Buffer
// nobody looks at).
execFileSync("true", [], { stdio: "pipe" });
console.log("done");

// execFileSync's `shell` value is read at the call even when the expression's
// type narrows to the literal true or false: Node evaluates the option like
// any other, so a validation helper that returns the literal runs. Skipping
// it would erase the check (and its recorded call).
const shellChecks: string[] = [];
function allowShell(): true {
  shellChecks.push("allow");
  return true;
}
function refuseShell(): false {
  shellChecks.push("refuse");
  return false;
}
console.log("shell-option:", JSON.stringify(execFileSync("echo via-shell", [], { encoding: "utf8", shell: allowShell() })));
console.log("shell-option-bare:", JSON.stringify(execFileSync("echo", ["plain"], { encoding: "utf8", shell: refuseShell() })));
console.log("shell-checks:", shellChecks.join(","));
