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
  /* Where the pipe splits a write into data events, and whether an exit
   * arrives before stdout reaches EOF, depends on scheduling. Collect the
   * text and report it from close, which follows both streams. */
  let echoed = "";
  let errors = "";
  err.on("data", (chunk) => {
    errors += String(chunk);
  });
  out.on("data", (chunk) => {
    echoed += String(chunk);
  });
  console.log("writable", sink.writable);
  writeAll(pipe, ["one", "two"]);
  child.on("close", (code) => {
    console.log("out", JSON.stringify(echoed));
    console.log("err", JSON.stringify(errors));
    console.log("exit", code);
  });
}

main();
