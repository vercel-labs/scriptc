// The stdio handles reach the full stream surface when a program uses it:
// child.stdout piped to process.stdout, a file stream piped into a
// child's stdin, and an 'error' listener on a NodeJS.WritableStream
// parameter that only receives the process streams. Each of these
// compiles the NodeJS stream interfaces as the node:stream classes.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function report(out: NodeJS.WritableStream, text: string): void {
  out.on("error", (err) => console.log("error", err.message));
  out.write(`${text}\n`);
}

function echo(text: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", `echo ${text}`], { stdio: ["ignore", "pipe", "inherit"] });
    child.stdout?.pipe(process.stdout);
    child.on("close", (code) => resolve(code));
  });
}

function cat(input: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn("cat", [], { stdio: ["pipe", "pipe", "inherit"] });
    child.stdout?.pipe(process.stdout);
    child.on("close", (code) => resolve(code));
    if (child.stdin) fs.createReadStream(input).pipe(child.stdin);
  });
}

async function main(): Promise<void> {
  report(process.stdout, "reported");
  report(process.stderr, "reported to stderr");
  console.log("echo exit", await echo("piped from a child"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriptc-node-stdio-"));
  const input = path.join(dir, "input.txt");
  fs.writeFileSync(input, "file contents through cat\n");
  console.log("cat exit", await cat(input));
  report(process.stdout, "stdout stays open");
  fs.rmSync(dir, { recursive: true });
}

void main();
