// The error codes the process surface raises, and the argument rules behind
// them: Node validates the argument it names and renders the value's own
// type, while arguments past the used ones only evaluate. Every shape prints
// the error's class, name, code and message so a divergence in any of them
// fails the comparison.
const path = require("path");

function shape(label, fn) {
  try {
    console.log(label, "ok", String(fn()));
  } catch (e) {
    console.log(label, [e.constructor.name, e.name, e.code, e.message, e instanceof Error].join(" | "));
  }
}

// chdir's validateString: the "directory" name, and a missing argument reads
// as undefined.
shape("chdir()", () => process.chdir());
shape("chdir(5)", () => process.chdir(5));
shape("chdir(null)", () => process.chdir(null));

// The credential setters validate their ids the way Node's wrapIdSetter
// does: validateUint32 first, then the name lookup.
shape("setuid()", () => process.setuid());
shape("setuid(1.5)", () => process.setuid(1.5));
shape("setuid(-1)", () => process.setuid(-1));
shape("setuid(2**32)", () => process.setuid(2 ** 32));
shape("setgid()", () => process.setgid());
shape("setgroups()", () => process.setgroups());
shape("setgroups('x')", () => process.setgroups("x"));
shape("setgroups([1.5])", () => process.setgroups([1.5]));
shape("initgroups()", () => process.initgroups());
shape("initgroups('x')", () => process.initgroups("x"));
shape("setuid(missing user)", () => process.setuid("__scriptc_missing_user__"));
shape("setgid(missing group)", () => process.setgid("__scriptc_missing_group__"));
shape("setgroups([missing])", () => process.setgroups(["__scriptc_missing_group__"]));
shape("initgroups(missing, 'x')", () => process.initgroups("__scriptc_missing_user__", "x"));

// The credential readers take no arguments; extras only evaluate.
console.log("getuid(1)", typeof process.getuid(1), typeof process.getuid());
console.log("getgroups(1)", Array.isArray(process.getgroups(1)), process.getgroups(1).length === process.getgroups().length);

// setSourceMapsEnabled validates its boolean; extras only evaluate.
shape("setSourceMapsEnabled()", () => process.setSourceMapsEnabled());
shape("setSourceMapsEnabled(1, 2)", () => process.setSourceMapsEnabled(1, 2));
shape("setSourceMapsEnabled(true, 2)", () => process.setSourceMapsEnabled(true, 2));
console.log("sourceMapsEnabled", process.sourceMapsEnabled);

// The capture callback: fn is a function or null, and a second callback
// while one is active is the dedicated code.
const capture = () => {};
shape("capture(undefined arg)", () => process.setUncaughtExceptionCaptureCallback(undefined));
shape("capture(5)", () => process.setUncaughtExceptionCaptureCallback(5));
shape("capture(fn)", () => process.setUncaughtExceptionCaptureCallback(capture));
shape("capture twice", () => process.setUncaughtExceptionCaptureCallback(capture));
console.log("has", process.hasUncaughtExceptionCaptureCallback(), process.hasUncaughtExceptionCaptureCallback(1));
shape("capture(null, 1)", () => process.setUncaughtExceptionCaptureCallback(null, 1));
console.log("has after clear", process.hasUncaughtExceptionCaptureCallback());

// umask parses an octal string or a number and range-checks it; extras
// evaluate in order.
shape("umask('9')", () => process.umask("9"));
shape("umask(4294967296)", () => process.umask(4294967296));
shape("umask(-1)", () => process.umask(-1));
console.log("umask('0022', 1, side)", typeof process.umask("0022", 1, console.log("umask side")));

// kill validates the pid and the signal, and the signal names are checked
// before the syscall, so these never signal anyone.
shape("kill bad signal", () => process.kill(process.pid, "SIGNOPE"));
shape("kill fractional signal", () => process.kill(process.pid, 0.5));
shape("kill string pid", () => process.kill("x", "SIGTERM"));
shape("kill fractional pid", () => process.kill(1.5, "SIGTERM"));
shape("kill surplus", () => process.kill(process.pid, "SIGNOPE", 1));

// debugPort's setter admits 0 and 1024..65535.
shape("debugPort 5", () => {
  process.debugPort = 5;
});
shape("debugPort 1e9", () => {
  process.debugPort = 1e9;
});
console.log("debugPort unchanged", process.debugPort === 9229);

// hrtime needs an Array base and cpuUsage an object; memoryUsage ignores
// arguments and rss reads the resident set on demand.
shape("hrtime(5)", () => process.hrtime(5));
shape("cpuUsage(5)", () => process.cpuUsage(5));
console.log("memoryUsage(5)", typeof process.memoryUsage(5).rss, process.memoryUsage(5).rss > 0);
console.log("rss(5)", process.memoryUsage.rss(5) > 0, process.memoryUsage.rss(console.log("rss side")) > 0);

// A failed chdir carries the SystemError fields; Node names the working
// directory as path and the target as dest.
const missing = path.join(__dirname, "definitely-not-here");
try {
  process.chdir(missing);
  console.log("chdir missing", "no throw");
} catch (e) {
  console.log("chdir missing", e.name, e.code, e.syscall, typeof e.errno, e.errno < 0, typeof e.path, e.dest === missing);
  console.log(e.message.startsWith("ENOENT: no such file or directory, chdir"), e instanceof Error);
}
