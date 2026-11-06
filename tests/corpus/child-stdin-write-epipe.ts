import { spawn } from "node:child_process";

/* The child closes its stdin (the pipe's read end) and reports it on
 * stdout, then stays alive. Every write to the closed pipe fails with
 * EPIPE: Node answers false from the failing write, hands the error to its
 * completion callback and emits it, and refuses the next write. */
const child = spawn("sh", ["-c", "exec 0<&-; echo closed; sleep 0.3"], {
  stdio: ["pipe", "pipe", "pipe"],
});
const input = child.stdin;
const output = child.stdout;
if (input === null || output === null) throw new Error("missing pipe");
input.on("error", (err) =>
  console.log("error", (err as NodeJS.ErrnoException).code, err.message),
);
input.on("drain", () => console.log("drain"));
output.on("data", (chunk) => {
  if (String(chunk).trim() !== "closed") return;
  const first = input.write("hello", (error) => {
    console.log("cb", error === null || error === undefined ? "ok" : (error as Error).message);
    const second = input.write("again", (next) => {
      console.log("cb2", next === null || next === undefined ? "ok" : (next as Error).message);
    });
    console.log("write2", second);
  });
  console.log("write1", first);
});
child.on("exit", (code) => console.log("exit", code));
