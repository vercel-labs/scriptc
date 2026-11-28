// DEP0040 for require("punycode"): reported once, on the next tick after
// the requiring turn, to the stderr report and the 'warning' listeners;
// require("node:punycode") is the same module and does not report again.
// process.noDeprecation drops the report and the listener call. A program
// whose only deferred work is that report still delivers it before exit.
// The program re-runs itself per case and prints each child's output with
// process ids normalized.
"use strict";
const { spawnSync } = require("child_process");

const mode = process.argv[2];
if (mode === "direct") {
  process.on("warning", (w) => console.log("listener", w.name, w.code, w.message));
  process.nextTick(() => console.log("earlier tick"));
  console.log("before require");
  const direct = require("punycode");
  console.log("after require", direct.toASCII("bücher.de"));
  const prefixed = require("node:punycode");
  console.log("prefixed", prefixed.toUnicode("xn--bcher-kva.de"));
  setTimeout(() => console.log("timer"), 0);
} else if (mode === "silenced") {
  process.on("warning", (w) => console.log("listener", w.code));
  process.noDeprecation = true;
  const silencedModule = require("punycode");
  console.log("silenced", silencedModule.encode("ü"));
} else if (mode === "sync") {
  // No listener, no tick and no timer: the queued report is the program's
  // only deferred work, and it is delivered before exit.
  const syncModule = require("node:punycode");
  console.log("sync", syncModule.version);
} else {
  for (const child of ["direct", "silenced", "sync"]) {
    const run = spawnSync(process.execPath, [process.argv[1], child], { encoding: "utf8" });
    console.log(`== ${child}: status ${run.status}`);
    console.log(run.stdout);
    console.log(run.stderr.replace(/\(node:\d+\)/g, "(node:<pid>)"));
  }
}
