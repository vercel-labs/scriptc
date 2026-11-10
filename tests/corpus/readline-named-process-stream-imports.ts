// @clack/core's shape: createInterface over the process streams bound by
// NAME from node:process. The module exports the global's own stream
// objects, so the interface is the one `process.stdin`/`process.stdout`
// build — the prompt is written under the harness's pipe, and the closed
// stdin closes it without answering.
import * as readline from "node:readline";
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";

readline.cursorTo(stdout, 3);
readline.clearLine(stdout, 0);
const rl = createInterface({ input: stdin, output: stdout });
rl.question("named> ", (answer) => {
  console.log("answer (never prints)", answer);
});
rl.on("close", () => {
  console.log("closed");
});
console.log("main done");
