import { spawn } from "node:child_process";

/* A hand-written pipe interface — the reporter idiom: a helper writes
 * through the narrow surface child.stdin lowers directly. */
interface Pipe {
  write(chunk: string): boolean;
  end(): void;
}

function writeAll(pipe: Pipe, lines: string[]): void {
  for (const line of lines) pipe.write(line + "\n");
  pipe.end();
}

const child = spawn("cat", [], { stdio: ["pipe", "pipe", "pipe"] });
child.stdout?.on("data", (chunk) => process.stdout.write(chunk));
if (child.stdin !== null) writeAll(child.stdin, ["a", "b"]);
child.on("exit", (code) => console.log("exit", code));
