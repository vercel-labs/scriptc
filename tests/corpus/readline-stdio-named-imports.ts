// createInterface over the node:process NAMED-IMPORT bindings (`import {
// stdin, stdout } from "node:process"` — the @clack/prompts spelling):
// the bindings name the same process streams the member spellings do.
// The program re-runs itself with piped input: the plain named imports
// carry a question round-trip, a shorthand option and the positional
// argument take the aliased stdin binding, and an aliased stderr
// binding writes the prompt to descriptor 2.
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { stdin, stdin as input, stdout, stderr as errStream } from "node:process";

const mode = process.argv[2];
if (mode === "ask") {
  const rl = createInterface({ input: stdin, output: stdout });
  rl.question("q? ", (answer: string) => {
    console.log("got", answer);
    rl.close();
  });
} else if (mode === "shorthand") {
  const rl = createInterface({ input, output: stdout });
  rl.question("s? ", (answer: string) => {
    console.log("got", answer);
    rl.close();
  });
} else if (mode === "positional") {
  const rl = createInterface(input);
  rl.on("line", (line: string) => console.log("line:", line));
  rl.on("close", () => console.log("closed"));
} else if (mode === "stderr") {
  const rl = createInterface({ input, output: errStream });
  rl.question("err? ", (answer: string) => {
    console.log("got", answer);
    rl.close();
  });
} else {
  for (const [child, data] of [
    ["ask", "alice\n"],
    ["shorthand", "bob\n"],
    ["positional", "one\ntwo\n"],
    ["stderr", "carol\n"],
  ]) {
    const out = execFileSync(process.execPath, [process.argv[1]!, child!], {
      input: data,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "inherit"],
    });
    console.log(child, JSON.stringify(out));
  }
}
