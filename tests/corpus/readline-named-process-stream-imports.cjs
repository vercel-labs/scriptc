"use strict";
// The CommonJS twin of the named-import shape: destructuring the
// node:process module object binds the global's stream objects, so the
// interface reads stdin and writes stdout exactly like the spelled
// `process.stdin`/`process.stdout` form.
const { createInterface } = require("node:readline");
const { stdin, stdout } = require("node:process");

const rl = createInterface({ input: stdin, output: stdout });
rl.question("named> ", (answer) => {
  console.log("answer (never prints)", answer);
});
rl.on("close", () => {
  console.log("closed");
});
console.log("main done");
