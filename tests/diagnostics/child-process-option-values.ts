// The execFile and exec callback forms bind no option values, so a
// Windows-only member whose value has to be evaluated (a call) has no place
// to run there and is refused by name instead of being dropped.
import { exec, execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";

function hidden(): boolean {
  return true;
}

execFile("/bin/echo", [], { encoding: "utf8", windowsHide: hidden() }, () => {});
exec("echo", { windowsHide: hidden() }, () => {});

// The promisified forms bind no option values either, and a
// synchronous form cannot place such a value beside a conditional env spread
// or a stdio mode known only at run time.
const run = promisify(execFile);
const spare = process.argv.length > 9;
const mode: "pipe" | "inherit" = spare ? "inherit" : "pipe";
function limit(): number {
  return 1024;
}

void run("/bin/echo", [], { windowsHide: hidden() });
void run("/bin/echo", [], { maxBuffer: limit() });
execFileSync("/bin/echo", [], { windowsHide: hidden(), ...(spare ? { env: { TRAY: "x" } } : {}) });
spawnSync("/bin/echo", [], { stdio: mode, windowsHide: hidden() });
