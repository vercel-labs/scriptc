// readline over a Readable parameter that receives process.stdin.
import * as readline from "node:readline";
import type { Readable } from "node:stream";

function lines(input: Readable, onLine: (line: string) => void, onClose: () => void): void {
  const rl = readline.createInterface({ input });
  rl.on("line", onLine);
  rl.on("close", onClose);
}
let count = 0;
lines(
  process.stdin,
  (line) => {
    count++;
    console.log(`${count}: ${line}`);
  },
  () => {
    console.log("closed after", count);
  },
);
