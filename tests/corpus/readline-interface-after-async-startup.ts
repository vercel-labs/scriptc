// A readline interface created after the program's startup work: the
// interface comes up after two awaited operations, with the terminal flag a
// boolean the program reads (process.stdin.isTTY, false for piped input), and
// the program waits on end-of-input with a long-lived await loop rather than
// on open handles. When stdin is a pipe or /dev/null, 'end' still arrives,
// rl.close() runs from that listener, 'close' fires, and the program exits
// where Node exits.
import { createInterface } from "node:readline";

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// The startup reads, before the interface exists.
await wait(10);
await wait(20);
console.log("startup done");

const interactive = process.stdin.isTTY === true;
console.log("interactive", interactive);
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: interactive });
rl.setPrompt("> ");
rl.prompt();

rl.on("line", (input: string) => {
  const text = input.trim();
  if (!text) return rl.prompt();
  console.log("line", JSON.stringify(text));
});

// Piped input: leave when it ends.
let closed = false;
if (!interactive) process.stdin.on("end", () => rl.close());
rl.on("close", () => {
  closed = true;
  process.stdout.write("closed\n");
});

// A long-lived wait loop, as a chat client's long poll would be: the process
// stays alive here until the interface closes, then ends on its own.
while (!closed) {
  await wait(1000);
}
console.log("exiting");
