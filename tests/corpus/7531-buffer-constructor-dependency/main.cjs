// The deprecated Buffer constructor called from a dependency under
// node_modules: Node reports no DEP0005 for those calls, and the program's
// own first call reports it once, on the next tick.
// The program re-runs itself and prints the child's output with process
// ids normalized.
"use strict";
const { spawnSync } = require("node:child_process");
const legacy = require("legacy-buf");

function child() {
  process.on("warning", (w) => console.log("listener", w.name, w.code));

  console.log(legacy.construct("hi", "utf8"), legacy.construct(3), legacy.call([1, 2]));
  const storage = new Uint8Array([1, 2, 3, 4]).buffer;
  console.log(legacy.construct(storage, 1, 2), legacy.many(5));
  try {
    legacy.construct(4, "hex");
  } catch (e) {
    console.log(e.code);
  }
  process.nextTick(() => {
    console.log("tick");
    console.log(new Buffer("own"));
    console.log(Buffer(2), new Buffer([9]));
    setTimeout(() => console.log("timer"), 0);
  });
}

if (process.argv[2] === "child") {
  child();
} else {
  const run = spawnSync(process.execPath, [process.argv[1], "child"], { encoding: "utf8" });
  console.log(`status: ${run.status}`);
  console.log(run.stdout);
  console.log(run.stderr.replace(/\(node:\d+\)/g, "(node:<pid>)"));
}
