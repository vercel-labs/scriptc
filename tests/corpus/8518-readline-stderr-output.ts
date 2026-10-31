// createInterface with output: process.stderr: the prompt of question(),
// prompt() and setPrompt() go to fd 2, while an interface on process.stdout
// (and the program's console output) still goes to fd 1. The interface's
// terminal mode follows the output's own isTTY, so a piped stderr makes it
// a non-terminal interface. A stream input opens through the same stderr
// output. Each case re-runs this program with piped stdin; the child's
// stderr is echoed to ours, which the harness compares byte for byte.
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { createInterface } from "node:readline";
import { createInterface as createPromisesInterface } from "node:readline/promises";

const mode = process.argv[2];

if (mode === "question") {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  rl.question("name? ", (answer: string) => {
    console.log("hello", answer);
    rl.close();
  });
  rl.on("close", () => console.log("closed"));
} else if (mode === "promises") {
  const rl = createPromisesInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question("age? ");
  console.log("age", answer);
  rl.close();
} else if (mode === "prompt") {
  const rl = createInterface({ input: process.stdin, output: process.stderr, prompt: "> " });
  rl.prompt();
  rl.write("typed");
  rl.setPrompt("$ ");
  rl.prompt();
  rl.on("line", (line: string) => console.log("line", line));
  rl.on("close", () => console.log("closed", rl.terminal));
} else if (mode === "stream") {
  const rl = createInterface({ input: Readable.from(["first\nsecond\n"]), output: process.stderr });
  rl.on("line", (line: string) => console.log("stream line", line));
  rl.on("close", () => console.log("stream closed", rl.terminal));
} else if (mode === "stdout") {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.question("stdout? ", (answer: string) => {
    console.log("answer", answer);
    rl.close();
  });
} else {
  for (const [child, input] of [
    ["question", "Ada\nrest\n"],
    ["promises", "41\n"],
    ["prompt", "typed\n"],
    ["stream", ""],
    ["stdout", "blue\n"],
  ]) {
    const stdout = execFileSync(process.execPath, [process.argv[1]!, child!], {
      encoding: "utf8",
      input,
    });
    console.log(child, JSON.stringify(stdout));
  }
}
