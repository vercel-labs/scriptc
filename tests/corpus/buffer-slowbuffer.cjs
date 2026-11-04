// buffer.SlowBuffer as Node 24 runs it: the deprecate() wrapper reports
// DEP0030 on the next tick of its first call (once), then allocUnsafeSlow
// validates the size and allocates a Buffer outside the pool. Called
// directly, through a destructured binding, and through a stored value
// (named "deprecated", length 1). buffer.kMaxLength and
// buffer.constants.MAX_LENGTH are the largest length.
// The program re-runs itself and prints the child's output with process
// ids normalized.
"use strict";
const { spawnSync } = require("node:child_process");

function child() {
  const buffer = require("buffer");
  const { SlowBuffer } = require("buffer");
  const Stored = buffer.SlowBuffer;
  process.on("warning", (w) => console.log("listener", w.name, w.code, w.message));

  const made = SlowBuffer(4);
  console.log(made, Buffer.isBuffer(made), made.length, made.buffer.byteLength);
  console.log(Stored(0).length, typeof Stored, Stored.name, Stored.length);
  console.log(buffer.kMaxLength, buffer.kMaxLength === Number.MAX_SAFE_INTEGER);
  const { MAX_LENGTH } = buffer.constants;
  console.log(MAX_LENGTH === buffer.kMaxLength, buffer.constants.MAX_LENGTH);
  for (const size of [undefined, "6", true, {}, NaN, -1, Infinity, buffer.kMaxLength + 1]) {
    try {
      SlowBuffer(size);
      console.log("made", size);
    } catch (e) {
      console.log(String(size), e.name, e.code, e.message);
    }
  }
  console.log("sync end");
}

if (process.argv[2] === "child") {
  child();
} else {
  const run = spawnSync(process.execPath, [process.argv[1], "child"], { encoding: "utf8" });
  console.log(`status: ${run.status}`);
  console.log(run.stdout);
  console.log(run.stderr.replace(/\(node:\d+\)/g, "(node:<pid>)"));
}
