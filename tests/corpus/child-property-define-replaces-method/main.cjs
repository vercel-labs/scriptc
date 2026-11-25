"use strict";
// A definition through a function value replaces a declared child method.
// `define` holds Object.defineProperty, so only resolving the alias shows
// that a child receives a member here; the typed call below must reach the
// replacement the definition installed.
const { spawn } = require("child_process");
const replaceKill = require("./replace.cjs");
if (process.argv.at(2) === "child") {
  process.stdout.write("ready");
} else {
  const child = spawn(process.execPath, [process.argv[1], "child"]);
  console.log(replaceKill(child));
  console.log("kill", child.kill());
  console.log("killed", child.killed, child.exitCode);
  child.on("exit", (code) => console.log("exit", code));
}
