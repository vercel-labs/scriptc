// child_process.exec and execFile from a JavaScript module: the options
// record is untyped, so its members are read at run time. `env` REPLACES the
// shell form's environment, a deadline kills with the default SIGTERM, and a
// killSignal held in a const still resolves a lower-case name.
"use strict";
const { exec, execFile } = require("child_process");

/**
 * @param {string} tag
 * @param {Error | null} err
 * @param {string} stdout
 * @param {string} stderr
 */
function line(tag, err, stdout, stderr) {
  console.log(
    tag,
    JSON.stringify({
      failed: err !== null && err !== undefined,
      code: err ? (err.code ?? null) : null,
      killed: err ? (err.killed ?? null) : null,
      signal: err ? (err.signal ?? null) : null,
      message: err ? err.message : null,
      stdout,
      stderr,
    }),
  );
}

/**
 * @param {Error | null} error
 * @param {string} stdout
 * @param {string} stderr
 */
function onEnv(error, stdout, stderr) {
  line("exec-env", error, stdout, stderr);
  exec("sleep 5", { timeout: 80 }, onTimeout);
}

/**
 * @param {Error | null} error
 * @param {string} stdout
 * @param {string} stderr
 */
function onTimeout(error, stdout, stderr) {
  line("exec-timeout", error, stdout, stderr);
  const kill = "sigkill";
  execFile("/bin/sh", ["-c", "trap '' TERM; sleep 5"], { timeout: 80, killSignal: kill }, onKill);
}

/**
 * @param {Error | null} error
 * @param {string} stdout
 * @param {string} stderr
 */
function onKill(error, stdout, stderr) {
  line("execfile-kill", error, stdout, stderr);
}

console.log("scheduled");
exec('printf "%s" "$FOO"', { env: { FOO: "shell" } }, onEnv);
