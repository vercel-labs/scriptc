// @normalize-pid
// spawnSync with the shell enabled AND separate arguments. Node runs the
// command and the arguments as one line — `file + " " + args.join(" ")`,
// concatenated and never escaped — and the first call of the process that
// does so reports DEP0190 on stderr through process.emitWarning. With the
// shell off, the same list is the argument vector. A typed options value
// decides between the two at run time, per call.
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";

type Runner = (
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => string;
const run: Runner = (command, args, options) => spawnSync(command, args, options).stdout;

// Shell off: each argument stays one argument, spaces and operators included.
const plain: SpawnSyncOptionsWithStringEncoding = { encoding: "utf8" };
console.log("off:", JSON.stringify(run("/bin/echo", ["a  b", "c;d", "$HOME"], plain)));

// Shell on: the list joins onto the command with single spaces, and the
// shell splits, expands and sequences the result.
const shelled: SpawnSyncOptionsWithStringEncoding = { encoding: "utf8", shell: true };
console.log(
  "on:",
  JSON.stringify(run("echo", ["a   b", "$((1+2))", ";", "echo", "second"], shelled)),
);

// The member is read at each call.
for (const shell of [false, true]) {
  const options: SpawnSyncOptionsWithStringEncoding = { encoding: "utf8", shell };
  console.log("runtime", shell, JSON.stringify(run("/bin/echo", ["x;", "echo", "y"], options)));
}

// A replacement environment takes the other entry point; the line is the same.
const withEnv: SpawnSyncOptionsWithStringEncoding = {
  encoding: "utf8",
  shell: true,
  env: { GREETING: "hi" },
};
console.log("env:", JSON.stringify(run("echo", ["$GREETING", "there"], withEnv)));

// An inline `shell: true` joins the same way.
console.log(
  "literal:",
  JSON.stringify(spawnSync("echo", ["lit", "$((2*3))"], { encoding: "utf8", shell: true }).stdout),
);

// The shell's own status comes back as data.
console.log("status:", spawnSync("exit", ["3"], shelled).status);

// An empty list at run time is the command alone.
const none: string[] = [];
console.log("empty:", JSON.stringify(run("echo solo", none, shelled)));
