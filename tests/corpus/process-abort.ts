// process.abort() flushes what was written and then terminates the process by
// SIGABRT — a parent sees signal "SIGABRT" and no exit status, and the code
// after the call never runs. Node also prints its native and JavaScript stack
// dumps to stderr; those name Node's own frames, so the compiled binary raises
// the signal without them (the child's stderr is not compared here).
import { spawnSync } from "node:child_process";

if (process.argv[2] === "child") {
  console.log("before abort");
  if (process.argv[3] === "abort") process.abort();
  console.log("after abort");
} else {
  console.log("typeof", typeof process.abort, typeof process.finalization);
  for (const mode of ["abort", "plain"]) {
    const result = spawnSync(process.execPath, [process.argv[1], "child", mode], {
      encoding: "utf8",
    });
    console.log(mode, "status", result.status, "signal", result.signal);
    console.log("stdout", JSON.stringify(result.stdout));
  }
}
