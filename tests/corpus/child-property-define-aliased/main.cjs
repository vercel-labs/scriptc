"use strict";
// A JavaScript helper defines a property on a child through a define function
// held in a variable. The call names no builtin of its own, so only resolving
// the alias shows that a child receives properties here: without the child's
// property table the definition throws a TypeError.
const { spawn } = require("child_process");
const tag = require("./tag.cjs");
if (process.argv.at(2) === "child") {
  process.stdout.write("ready");
} else {
  const child = spawn(process.execPath, [process.argv[1], "child"]);
  tag(child);
  console.log(child.stamped);
  child.on("exit", (code) => console.log("exit", code));
}
