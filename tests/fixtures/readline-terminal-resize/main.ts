// A terminal readline interface on process.stdout redraws its prompt and
// line when the terminal is resized. The observer types "abc", narrows the
// terminal to four columns, and sends SIGWINCH; the refresh must match
// Node's escape sequences.
import { createInterface } from "node:readline";

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
  prompt: "> ",
});
rl.on("line", (line) => {
  process.stdout.write(`LINE ${line}\n`);
  rl.close();
});
rl.prompt();
