// Node evaluates an options object's members in source order, so a runtime
// stdio tuple entry reads the value it has at that point in the literal. A
// later member whose expression changes that value must not move ahead of the
// read, and a member that comes first must change it before the read.
import { spawnSync } from "node:child_process";

// The harness pins SCRIPTC_TEST_ENV to a known value, so this read answers
// at run time; the checker sees the union at each stdio read and cannot
// fold the initializers below.
const pinned = process.env.SCRIPTC_TEST_ENV === "from-harness";

let mode: "pipe" | "ignore" = pinned ? "pipe" : "ignore";
const setIgnoreAndUseTmp = (): string => {
  mode = "ignore";
  return "/tmp";
};

// stdio before cwd: the tuple reads "pipe", then cwd's call changes the
// variable — too late to affect the mode the tuple chose.
const captured = spawnSync("echo", ["captured"], {
  stdio: ["pipe", mode, "pipe"],
  cwd: setIgnoreAndUseTmp(),
  encoding: "utf8",
});
console.log(`stdio first: ${JSON.stringify(captured.stdout)} ${captured.status}`);

let later: "pipe" | "ignore" = pinned ? "ignore" : "pipe";
const setPipeBefore = (): string => {
  later = "pipe";
  return "/tmp";
};

// cwd before stdio: the read already sees what cwd's call did, so stdout is
// captured.
const seen = spawnSync("echo", ["seen"], {
  cwd: setPipeBefore(),
  stdio: ["pipe", later, "pipe"],
  encoding: "utf8",
});
console.log(`cwd first: ${JSON.stringify(seen.stdout)} ${seen.status}`);

// A runtime stdin slot resolves to the pipe the tuple names, and the child
// reads EOF with nothing to feed it.
let stdinMode: "pipe" | "ignore" = pinned ? "pipe" : "ignore";
const fed = spawnSync("cat", [], {
  stdio: [stdinMode, "pipe", "pipe"],
  encoding: "utf8",
});
console.log(`stdin slot: ${JSON.stringify(fed.stdout)} ${fed.status}`);

// The same order without cwd, input, or shell: the timeout member runs after
// the tuple's read, so stdout is captured.
let plainTimeout: "pipe" | "ignore" = pinned ? "pipe" : "ignore";
const timed = spawnSync("echo", ["timed"], {
  stdio: ["pipe", plainTimeout, "pipe"],
  timeout: ((plainTimeout = "ignore"), 5000),
  encoding: "utf8",
});
console.log(`timeout later: ${JSON.stringify(timed.stdout)} ${timed.status}`);

console.log(`after: ${mode} ${later} ${plainTimeout}`);
