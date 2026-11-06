import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";

/* Piping child output needs the general stream representation, so child
 * stdin is the runtime Writable over the same pipe. The child closes its
 * stdin (the pipe's read end) and stays alive: the write that reaches the
 * closed pipe fails, and Node answers false for it and for every write
 * after it, with one EPIPE error. */
const child = spawn("sh", ["-c", "exec 0<&-; echo closed; sleep 0.3"], {
  stdio: ["pipe", "pipe", "pipe"],
});
const input = child.stdin;
const output = child.stdout;
if (input === null || output === null) throw new Error("missing pipe");
const through = new PassThrough();
through.on("data", (chunk) => console.log("through", String(chunk).trim()));
output.pipe(through);
input.on("error", (err) =>
  console.log("error", (err as NodeJS.ErrnoException).code, err.message),
);
input.on("drain", () => console.log("drain"));
through.on("data", () => {
  console.log("write1", input.write("hello"));
  console.log("write2", input.write("again"));
});
child.on("exit", (code) => console.log("exit", code));
