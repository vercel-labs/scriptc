// child.stdin forms beyond write(string): a write with an encoding, end
// with a final chunk, and destroy with an error observed by an 'error'
// listener. They compile through the general stream representation, where
// child.stdin is the child's bridged Writable.
import { spawn } from "node:child_process";

function feed(): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn("cat", [], { stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on("close", (code) => {
      console.log("fed", JSON.stringify(out), code);
      resolve();
    });
    child.stdin.write("first ", "utf8");
    child.stdin.end("second\n");
  });
}

function abort(): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn("cat", [], { stdio: ["pipe", "ignore", "inherit"] });
    child.stdin.on("error", (err) => console.log("stdin error", err.message));
    child.on("close", (code) => {
      console.log("aborted", code);
      resolve();
    });
    child.stdin.destroy(new Error("stop"));
  });
}

async function main(): Promise<void> {
  await feed();
  await abort();
}

void main();
