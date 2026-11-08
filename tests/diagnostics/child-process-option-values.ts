// The execFile and exec callback forms take env, timeout, killSignal and
// signal. What their lowering does not carry is refused by name where it is
// written: a timer option a conditional spread carries and the literal
// writes again (the carried value would be evaluated and replaced), a spread
// that carries a member the conditional form does not hold, and a spread of
// a value that is not such a conditional.
import { exec, execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";

const dim = process.argv.length > 9;

exec("echo", { ...(dim ? { timeout: 50 } : {}), cwd: "/", timeout: 60 }, () => {});
execFile("/bin/echo", [], { ...(dim ? { maxBuffer: 64 } : {}) }, () => {});
const shared = { timeout: 70 };
execFile("/bin/echo", [], { ...shared, cwd: "/" }, () => {});

// A Windows-only member whose value has to be evaluated (a call) runs where
// it sits in the callback forms. The promisified forms bind no option
// values, so there it has no place to run and is refused by name instead of
// being dropped, and a synchronous form cannot place it beside a conditional
// env spread or a stdio mode known only at run time.
function hidden(): boolean {
  return true;
}

const run = promisify(execFile);
const spare = process.argv.length > 9;
const mode: "pipe" | "inherit" = spare ? "inherit" : "pipe";

void run("/bin/echo", [], { windowsHide: hidden() });
execFileSync("/bin/echo", [], { windowsHide: hidden(), ...(spare ? { env: { TRAY: "x" } } : {}) });
spawnSync("/bin/echo", [], { stdio: mode, windowsHide: hidden() });
