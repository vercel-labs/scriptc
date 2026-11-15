// A terminal readline interface on process.stdin: Ctrl+Z emits 'SIGTSTP'
// when a listener is registered, and otherwise suspends the process until
// SIGCONT, after which the interface pauses, emits 'SIGCONT' and redraws
// its prompt and line. The observer types a line, sends Ctrl+Z and drives
// the suspend/resume cycle; the pause, resume, SIGCONT and line markers
// make the observed order visible.
import { createInterface } from "node:readline";

const withListener = process.argv.includes("--listener");
const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
  prompt: "> ",
});
if (withListener) rl.on("SIGTSTP", () => process.stdout.write("TSTP\n"));
rl.on("SIGCONT", () => process.stdout.write("CONT\n"));
rl.on("pause", () => process.stdout.write("PAUSE\n"));
rl.on("resume", () => process.stdout.write("RESUME\n"));
rl.on("line", (line) => {
  process.stdout.write(`LINE ${line}\n`);
  rl.close();
});
rl.prompt();
