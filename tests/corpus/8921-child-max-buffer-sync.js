// maxBuffer in the synchronous capture forms. Node counts stdout and
// stderr together in bytes; past the limit it kills the child, closes the
// pipes and reports ENOBUFS (execSync and execFileSync throw it, spawnSync
// answers it as `error`), keeping the output read so far. The default is
// 1024 * 1024, 0 means no limit, and a negative or NaN value throws
// ERR_OUT_OF_RANGE before anything spawns.
import { execFileSync, execSync, spawnSync } from "node:child_process";

function report(tag, error) {
  console.log(tag, "name:", error.name, "message:", JSON.stringify(error.message));
  console.log(tag, "code:", error.code, "errno<0:", error.errno < 0, "syscall:", JSON.stringify(error.syscall));
  console.log(tag, "path:", JSON.stringify(error.path), "spawnargs:", JSON.stringify(error.spawnargs));
  console.log(tag, "keys:", JSON.stringify(Object.keys(error)));
}
function thrown(run) {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
}

// One write of ten bytes against a limit of four. The child then sleeps,
// so the kill reaches a live process: status null, signal SIGTERM. The
// chunk that crossed the limit is kept whole.
let started = Date.now();
const over = thrown(() => execSync("printf abcdefghij; sleep 20", { maxBuffer: 4, encoding: "utf8" }));
report("execSync", over);
console.log("execSync status:", over.status, "signal:", over.signal, "self:", over.error === over);
console.log("execSync stdout:", JSON.stringify(over.stdout), "stderr:", JSON.stringify(over.stderr));
console.log("execSync output:", JSON.stringify(over.output), "pid:", typeof over.pid);
console.log("execSync returned at the limit:", Date.now() - started < 10000);

// Without an encoding the outputs are Buffers.
const raw = thrown(() => execSync("printf abcdefghij; sleep 20", { maxBuffer: 4 }));
console.log("buffers:", raw.code, Buffer.isBuffer(raw.stdout), raw.stdout.length, raw.stderr.length);

// stderr counts toward the same limit, alone and together with stdout.
const errOnly = thrown(() =>
  execSync("printf abcdefghij >&2; sleep 20", { maxBuffer: 4, encoding: "utf8", stdio: "pipe" }),
);
console.log("stderr only:", errOnly.code, JSON.stringify(errOnly.stdout), JSON.stringify(errOnly.stderr));
const both = thrown(() =>
  execSync("printf abc; sleep 0.2; printf abc >&2; sleep 20", { maxBuffer: 4, encoding: "utf8", stdio: "pipe" }),
);
console.log("both:", both.code, JSON.stringify(both.stdout), JSON.stringify(both.stderr));

// At the limit exactly, nothing happens; 0 and Infinity mean no limit.
console.log("exact:", JSON.stringify(execSync("printf abcd", { maxBuffer: 4, encoding: "utf8" })));
console.log("zero:", execSync("printf abcdefghij", { maxBuffer: 0, encoding: "utf8" }).length);
console.log("infinity:", execSync("printf abcdefghij", { maxBuffer: Infinity, encoding: "utf8" }).length);
// A fractional limit is compared as it is: five bytes pass 4.5.
console.log("fraction under:", execSync("printf abcd", { maxBuffer: 4.5, encoding: "utf8" }).length);
console.log("fraction over:", thrown(() => execSync("printf abcde; sleep 20", { maxBuffer: 4.5 })).code);

// A computed limit, evaluated once.
let evaluations = 0;
const limit = () => {
  evaluations++;
  return 4;
};
console.log("computed:", thrown(() => execSync("printf abcdefghij; sleep 20", { maxBuffer: limit() })).code, evaluations);

// execFileSync: the message, path and spawnargs name the file.
const file = thrown(() =>
  execFileSync("/bin/sh", ["-c", "printf abcdefghij; sleep 20"], { maxBuffer: 4, encoding: "utf8" }),
);
report("execFileSync", file);
console.log("execFileSync status:", file.status, "signal:", file.signal, JSON.stringify(file.stdout));

// The default limit is 1024 * 1024 for every form.
console.log("default at:", execSync("head -c 1048576 /dev/zero").length);
const past = thrown(() => execSync("head -c 1048577 /dev/zero; sleep 20"));
console.log("default over:", past.code, past.stdout.length > 1048576, past.signal);
console.log("default over (file):", thrown(() => execFileSync("/bin/sh", ["-c", "head -c 2000000 /dev/zero; sleep 20"])).code);
const spawned = spawnSync("/bin/sh", ["-c", "head -c 1048577 /dev/zero; sleep 20"]);
console.log("spawnSync status:", spawned.status, "signal:", spawned.signal, spawned.stdout.length > 1048576);
report("spawnSync", spawned.error);
const spawnedCwd = spawnSync("/bin/sh", ["-c", "head -c 1048577 /dev/zero; sleep 20"], { cwd: process.cwd() });
console.log("spawnSync cwd:", spawnedCwd.status, spawnedCwd.signal, spawnedCwd.error.code);
const fits = spawnSync("/bin/sh", ["-c", "head -c 1048576 /dev/zero"]);
console.log("spawnSync at:", fits.status, fits.stdout.length, fits.error === undefined);

// A child that had already exited keeps its own status beside the error.
// (The kill races the exit, so only the stable fields are printed.)
const quick = thrown(() => execSync("printf abcdefghij", { maxBuffer: 4, encoding: "utf8" }));
console.log("quick:", quick.code, JSON.stringify(quick.stdout), quick.status === 0 || quick.signal === "SIGTERM");

// An invalid limit throws before the command runs.
for (const bad of [-1, NaN]) {
  const error = thrown(() => execSync("echo ran >&2", { maxBuffer: bad }));
  console.log("invalid:", error.name, error.code, JSON.stringify(error.message));
}
const badFile = thrown(() => execFileSync("/bin/echo", ["ran"], { maxBuffer: -0.5 }));
console.log("invalid file:", badFile.name, badFile.code, JSON.stringify(badFile.message));

// A limit belongs to its own call: the next one has the default again.
console.log("after:", execSync("printf abcdefghij", { encoding: "utf8" }));
