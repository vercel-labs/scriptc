import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

/* A hand-written pipe interface: child.stdin fills it, and its members
 * lower against the child's stdin handle. */
interface Pipe {
  write(chunk: string): boolean;
  end(): void;
}

function writeAll(pipe: Pipe, lines: string[]): void {
  for (const line of lines) pipe.write(line + "\n");
  pipe.end();
}

function main(): void {
  const child = spawn("cat", [], { stdio: ["pipe", "pipe", "pipe"] });
  const out: Readable | null = child.stdout;
  const err: Readable | null = child.stderr;
  const sink: Writable | null = child.stdin;
  const pipe: Pipe | null = child.stdin;
  if (out === null || err === null || sink === null || pipe === null) {
    throw new Error("missing pipe");
  }
  err.on("data", (chunk) => console.log("err", String(chunk)));
  out.on("data", (chunk) => console.log("out", String(chunk).trim()));
  console.log("writable", sink.writable);
  writeAll(pipe, ["one", "two"]);
  child.on("exit", (code) => console.log("exit", code));
}

main();
