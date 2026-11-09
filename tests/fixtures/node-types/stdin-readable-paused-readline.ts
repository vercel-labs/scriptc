// readline over a Readable that receives process.stdin after it was paused:
// the interface resumes its input, as in Node, and reads every line.
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

function lines(stream: Readable): void {
  const seen: string[] = [];
  const rl = createInterface({ input: stream });
  rl.on("line", (line) => seen.push(line));
  rl.on("close", () => console.log("lines", seen.length, seen.join("|"), stream.isPaused()));
}

process.stdin.pause();
lines(process.stdin);
