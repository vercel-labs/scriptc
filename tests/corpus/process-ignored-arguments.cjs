// @exit: 3
// Node's process functions read only the arguments they document, but a
// JavaScript call still evaluates every argument left to right before the
// call, and a caller the type checker does not fence can pass extras: the
// extras run (a throw in one propagates before the call) while the answer
// stays the documented one.
"use strict";

const log = [];
const note = (tag) => {
  log.push(tag);
  return 0;
};
const boom = () => {
  throw new Error("argument threw");
};

// @ts-expect-error -- cwd takes no arguments, and still evaluates them
const cwd = process.cwd(note("cwd"));
console.log("cwd", typeof cwd, cwd.length > 0, log.join(","));

// @ts-expect-error -- uptime takes no arguments
console.log("uptime", typeof process.uptime(note("uptime")));

// @ts-expect-error -- availableMemory takes no arguments
console.log("availableMemory", typeof process.availableMemory(note("available")));

// @ts-expect-error -- constrainedMemory takes no arguments
console.log("constrainedMemory", typeof process.constrainedMemory(note("constrained")));

// @ts-expect-error -- memoryUsage takes no arguments
const usage = process.memoryUsage(note("memory"));
console.log(
  "memoryUsage",
  ["rss", "heapTotal", "heapUsed", "external", "arrayBuffers"].every(
    (field) => typeof usage[field] === "number",
  ),
);

// @ts-expect-error -- resourceUsage takes no arguments
const rusage = process.resourceUsage(note("rusage"));
console.log("resourceUsage", typeof rusage.maxRSS, Array.isArray(rusage.userCPUTime) === false);

// @ts-expect-error -- getActiveResourcesInfo takes no arguments
console.log("activeResources", Array.isArray(process.getActiveResourcesInfo(note("resources"))));

// @ts-expect-error -- the credential readers take no arguments
console.log(
  "credentials",
  process.getuid(note("uid")),
  process.geteuid(note("euid")),
  process.getgid(note("gid")),
  process.getegid(note("egid")),
  process.getgroups(note("groups")).length > 0,
);

// umask(mask, ...ignored) sets the mask its first argument names.
const original = process.umask(0o022);
console.log("umask", process.umask(0o077, note("umask")) === 0o022, process.umask() === 0o077);
process.umask(original);

// kill(pid, signal, ...ignored) sends the signal; 0 only probes.
// @ts-expect-error -- kill takes two arguments
console.log("kill", process.kill(process.pid, 0, note("kill")));

// cpuUsage(prev, ...ignored): a falsy prev is the plain sample.
// @ts-expect-error -- cpuUsage takes one argument
const sample = process.cpuUsage(undefined, note("cpu"));
console.log("cpuUsage", typeof sample.user, typeof sample.system);

// hrtime.bigint(...ignored) reads the clock.
// @ts-expect-error -- bigint takes no arguments
console.log("hrtime", typeof process.hrtime.bigint(note("hrtime")));

// A surplus argument that throws propagates before the call runs.
try {
  // @ts-expect-error -- cwd takes no arguments
  process.cwd(boom());
  console.log("no throw");
} catch (error) {
  console.log("threw", error.message, log.join(","));
}

// The used arguments evaluate before the ignored ones, and a throw in the
// ignored tail leaves the used one's effect unapplied.
const before = process.umask();
try {
  // @ts-expect-error -- umask takes one argument
  process.umask(0o700, boom());
} catch (error) {
  console.log("mask kept", process.umask() === before, error.message);
}

// chdir(path, ...ignored) changes directory; the cwd is compared by suffix.
const fs = require("fs");
const os = require("os");
const dir = os.tmpdir() + "/scriptc-corpus-process-ignored-arguments";
fs.mkdirSync(dir, { recursive: true });
// @ts-expect-error -- chdir takes one argument
process.chdir(dir, note("chdir"));
console.log("chdir", process.cwd() === dir);
process.chdir(os.tmpdir());

console.log("order", log.join(","));

// process.exit(code, ...ignored) exits with the first argument's code.
log.push("exit");
// @ts-expect-error -- exit takes one argument
process.exit(3, note("after exit"));
