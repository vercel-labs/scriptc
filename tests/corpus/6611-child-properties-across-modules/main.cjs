"use strict";
// Properties a JavaScript module adds to a child it did not spawn: reads,
// accessor calls on the child, a write to a getter-only accessor, and the
// replaced kill. definer.cjs replaces kill through Reflect.defineProperty
// and writes a getter-only property with a long name.
const patched = require("./patcher.cjs");
const definer = require("./definer.cjs");
if (process.argv.at(2) === "child") {
  // The child reports that it started, then waits for the parent's SIGTERM.
  // It exits after 30 seconds without one.
  process.stdout.write("ready");
  setTimeout(() => {}, 30000);
} else {
  const child = patched();
  console.log(child.label);
  child.label = "x";
  console.log(child.stored, child.same);
  try {
    child.same = 1;
  } catch (e) {
    console.log(e instanceof TypeError, e.message);
  }
  child.on("close", (code) => {
    console.log("close", code, child.killedBy);
  });
  child.stdout.once("data", () => child.kill("SIGTERM"));
  child.on("close", () => definer());
}
