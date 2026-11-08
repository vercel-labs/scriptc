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

// The promisified forms do not run such a value either, and a
// synchronous form cannot place it beside a conditional env spread
// or a stdio mode known only at run time.
const run = promisify(execFile);
const spare = process.argv.length > 9;
const mode: "pipe" | "inherit" = spare ? "inherit" : "pipe";

void run("/bin/echo", [], { windowsHide: hidden() });
execFileSync("/bin/echo", [], { windowsHide: hidden(), ...(spare ? { env: { TRAY: "x" } } : {}) });
spawnSync("/bin/echo", [], { stdio: mode, windowsHide: hidden() });
