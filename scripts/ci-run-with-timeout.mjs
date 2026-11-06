#!/usr/bin/env node
/**
 * Run one command under a hard wall-clock limit, for CI steps whose own
 * failure would otherwise be a silent job-level cancellation.
 *
 * Usage:
 *   node scripts/ci-run-with-timeout.mjs --timeout=<seconds> --label=<text> -- <command> [args...]
 *
 * The command runs in its own process group, so a timeout kills the build
 * tools it started too instead of leaving them to hold the log open. A
 * timeout exits 124 after an ::error:: annotation that names the command and
 * how long it ran; the command's own exit status is passed through otherwise.
 */
import { spawn } from "node:child_process";

const separator = process.argv.indexOf("--");
const options = separator < 0 ? [] : process.argv.slice(2, separator);
const argument = (name) => {
  const prefix = `--${name}=`;
  const found = options.find((option) => option.startsWith(prefix));
  return found === undefined ? undefined : found.slice(prefix.length);
};
const timeout = Number(argument("timeout"));
const command = separator < 0 ? undefined : process.argv[separator + 1];
const commandArgs = separator < 0 ? [] : process.argv.slice(separator + 2);
if (command === undefined || !(timeout > 0)) {
  console.error(
    "usage: ci-run-with-timeout.mjs --timeout=<seconds> --label=<text> -- <command> [args...]",
  );
  process.exit(2);
}
const label = argument("label") ?? command;
const line = [command, ...commandArgs].join(" ");
const started = Date.now();
console.error(`${label}: running \`${line}\` with a ${timeout}s limit`);

const child = spawn(command, commandArgs, {
  stdio: "inherit",
  // A new process group lets the timeout reach everything the command started.
  detached: process.platform !== "win32",
});
const signalGroup = (signal) => {
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // The command already exited, or the group is gone.
  }
};
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  signalGroup("SIGKILL");
}, timeout * 1000);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => signalGroup(signal));

child.on("error", (error) => {
  clearTimeout(timer);
  console.error(`::error::${label} could not start: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  clearTimeout(timer);
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  if (timedOut) {
    console.error(
      `::error::${label} did not finish within ${timeout}s (ran ${seconds}s); ` +
        `killed \`${line}\` and everything it started`,
    );
    process.exit(124);
  }
  if (signal !== null) {
    console.error(`::error::${label} was killed by ${signal} after ${seconds}s`);
    process.exit(1);
  }
  console.error(`${label}: finished in ${seconds}s`);
  process.exit(code ?? 1);
});
