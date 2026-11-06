#!/usr/bin/env node
/**
 * Run one command under a hard wall-clock limit, for CI steps whose own
 * failure would otherwise be a silent job-level cancellation.
 *
 * Usage:
 *   node scripts/ci-run-with-timeout.mjs --timeout=<seconds> [--stall=<seconds>] --label=<text> -- <command> [args...]
 *
 * The command runs in its own process group, so a timeout kills the build
 * tools it started too instead of leaving them to hold the log open. A
 * timeout exits 124 after an ::error:: annotation that names the command and
 * how long it ran; the command's own exit status is passed through otherwise.
 *
 * --stall catches a hang inside a command that legitimately runs for a long
 * time: the command's output is forwarded as it arrives, and a command that
 * prints nothing for that many seconds is killed the same way. It needs the
 * command to report progress, so it is opt-in.
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
const stall = Number(argument("stall") ?? 0);
const command = separator < 0 ? undefined : process.argv[separator + 1];
const commandArgs = separator < 0 ? [] : process.argv.slice(separator + 2);
if (command === undefined || !(timeout > 0) || !(stall >= 0)) {
  console.error(
    "usage: ci-run-with-timeout.mjs --timeout=<seconds> [--stall=<seconds>] --label=<text> -- <command> [args...]",
  );
  process.exit(2);
}
const label = argument("label") ?? command;
const line = [command, ...commandArgs].join(" ");
const started = Date.now();
const limit = stall > 0 ? ` a ${stall}s silence limit` : "";
console.error(`${label}: running \`${line}\` with a ${timeout}s limit${limit}`);

// Watching output means owning the pipes; otherwise the command inherits the
// step's streams and its output is untouched.
const watched = stall > 0;
const child = spawn(command, commandArgs, {
  stdio: watched ? ["inherit", "pipe", "pipe"] : "inherit",
  // A new process group lets the timeout reach everything the command started.
  detached: process.platform !== "win32",
});
let lastOutput = Date.now();
if (watched) {
  const forward = (stream, sink) =>
    stream.on("data", (chunk) => {
      lastOutput = Date.now();
      sink.write(chunk);
    });
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
}
const signalGroup = (signal) => {
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // The command already exited, or the group is gone.
  }
};
let timedOut = false;
let stalled = false;
const timer = setTimeout(() => {
  timedOut = true;
  signalGroup("SIGKILL");
}, timeout * 1000);
const watchdog =
  stall > 0
    ? setInterval(() => {
        if (Date.now() - lastOutput > stall * 1000) {
          stalled = true;
          signalGroup("SIGKILL");
        }
      }, 1000)
    : undefined;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => signalGroup(signal));

child.on("error", (error) => {
  clearTimeout(timer);
  clearInterval(watchdog);
  console.error(`::error::${label} could not start: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  clearTimeout(timer);
  clearInterval(watchdog);
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  if (timedOut) {
    console.error(
      `::error::${label} did not finish within ${timeout}s (ran ${seconds}s); ` +
        `killed \`${line}\` and everything it started`,
    );
    process.exit(124);
  }
  if (stalled) {
    console.error(
      `::error::${label} printed nothing for ${stall}s (ran ${seconds}s); ` +
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
