// A child's stdin seen as a general stream (through `unknown`) answers
// write() as the direct pipe does: a write the pipe's writer accepts
// completes at once, even with bytes still queued for the pipe, and only a
// write past the high-water mark waits for 'drain'. Node's answer for
// 64 KiB + 1 differs by platform (true on Linux, false on macOS); each
// platform's run is compared with Node on the same platform.
import { spawn } from "node:child_process";
import type { Writable } from "node:stream";

function asStream(stream: Writable | null): Writable {
  const value: unknown = stream;
  if (value === null) throw new Error("missing pipe");
  return value as Writable;
}

const child = spawn(
  "node",
  // The child starts reading after 50 ms and exits 0 once it read every byte.
  ["-e", "setTimeout(() => { let n = 0; process.stdin.on('data', (b) => { n += b.length; }); process.stdin.on('end', () => { process.exitCode = n === 1115137 ? 0 : 1; }); }, 50)"],
  { stdio: ["pipe", "inherit", "inherit"] },
);
const input = asStream(child.stdin);
input.on("drain", () => {
  console.log("drain", input.writableLength, input.writableNeedDrain);
  input.end(() => console.log("end callback"));
});
input.on("finish", () => console.log("finish", input.writable));
input.on("close", () => console.log("stdin close"));
input.on("error", (err) => console.log("error", (err as NodeJS.ErrnoException).code));

console.log("small", input.write(Buffer.alloc(1024, 65), () => console.log("cb small")));
console.log("boundary", input.write(Buffer.alloc(64 * 1024 + 1, 66), () => console.log("cb boundary")));
console.log("big", input.write(Buffer.alloc(1024 * 1024, 67), () => console.log("cb big")));
console.log("need drain", input.writableNeedDrain);
child.on("exit", (code) => console.log("exit", code));
child.on("close", (code) => console.log("close", code));
