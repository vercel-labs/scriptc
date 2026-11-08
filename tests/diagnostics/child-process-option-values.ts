// The execFile and exec callback forms take env, timeout, killSignal and
// signal. What their lowering does not carry is refused by name where it is
// written: a timer option a conditional spread carries and the literal
// writes again (the carried value would be evaluated and replaced), a spread
// that carries a member the conditional form does not hold, and a spread of
// a value that is not such a conditional.
import { exec, execFile } from "node:child_process";

const dim = process.argv.length > 9;

exec("echo", { ...(dim ? { timeout: 50 } : {}), cwd: "/", timeout: 60 }, () => {});
execFile("/bin/echo", [], { ...(dim ? { maxBuffer: 64 } : {}) }, () => {});
const shared = { timeout: 70 };
execFile("/bin/echo", [], { ...shared, cwd: "/" }, () => {});
