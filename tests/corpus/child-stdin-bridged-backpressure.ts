// A child's stdin that crosses generic storage (an `unknown` value) goes
// through the child stdio bridge rather than the direct writer. The bridge
// answers a write by the writer's own answer, as Node's writer does: the
// 64 KiB + 1 chunk one was refused on macOS. A refused write completes at
// 'drain'.
import { spawn } from "node:child_process";
import type { Writable } from "node:stream";

const child = spawn(
  "node",
  [
    "-e",
    "let n=0;setTimeout(()=>{process.stdin.on('data',b=>n+=b.length);process.stdin.on('end',()=>console.log(n));process.stdin.resume()},50)",
  ],
  { stdio: ["pipe", "pipe", "pipe"] },
);
const input = child.stdin as unknown as Writable;
const output = child.stdout;
if (output === null) throw new Error("missing pipe");

let count = "";
let outputEnded = false;
let exited = false;
let exitCode: number | null = null;
output.on("data", (chunk: Buffer) => {
  count += chunk.toString();
});
output.on("end", () => {
  outputEnded = true;
});
input.on("drain", () => {
  console.log("drain", input.writable);
  input.end();
});
input.on("finish", () => console.log("finish", input.writable));
input.on("error", (error: Error) => console.log("error", error.message));
console.log("boundary", input.write(Buffer.alloc(64 * 1024 + 1, 66)));
console.log("write", input.write(Buffer.alloc(1024 * 1024, 65)));
child.on("exit", (code) => {
  exited = true;
  exitCode = code;
});
// Exit and EOF can arrive in either order; 'close' follows both, and by
// then the output stream has ended.
child.on("close", () => {
  console.log(
    `close ${count.trim()} exited=${exited} code=${exitCode} ended=${outputEnded} writable=${input.writable} writableEnded=${input.writableEnded}`,
  );
});
