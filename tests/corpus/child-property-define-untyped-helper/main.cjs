"use strict";
// A JavaScript helper defines a property on a child it receives through an
// untyped parameter. The checker resolves no type for that parameter, so the
// handle-property census has to count a definition whose target it cannot
// resolve: without the child's property table the runtime refuses the member
// and the definition throws a TypeError.
const { spawn } = require("child_process");
const tag = require("./tag.cjs");
if (process.argv.at(2) === "child") {
  process.stdout.write("ready");
} else {
  const child = spawn(process.execPath, [process.argv[1], "child"]);
  tag(child);
  console.log(child.label);
  child.on("exit", (code) => console.log("exit", code));
}
