// process.kill and process.chdir failures carry Node's error properties:
// an unknown signal name throws ERR_UNKNOWN_SIGNAL; a failed kill(2) is
// Node's errnoException ("kill ESRCH" with errno, code and syscall); a
// failed chdir names the working directory as path and the target as dest
// in "chdir '<cwd>' -> '<target>'".
"use strict";

function report(label, run) {
  try {
    run();
    console.log(label, "no throw");
  } catch (err) {
    const cwd = process.cwd();
    console.log(label, err.name, err.code, err.message.replace(cwd, "<cwd>"));
    console.log("  errno:", err.errno, "syscall:", err.syscall);
    console.log("  path is cwd:", err.path === cwd, "dest:", err.dest);
    console.log("  keys:", Object.keys(err).join(","));
  }
}

report("unknown signal", () => process.kill(process.pid, "SIGNOPE"));
// A pid above the kernel's pid_max (2^22) names no process.
report("missing process", () => process.kill(4194304 + 12345, 0));
report("chdir missing", () => process.chdir("/does/not/exist/kill-chdir"));
report("chdir file", () => process.chdir("/dev/null"));
console.log(process.kill(process.pid, 0));
