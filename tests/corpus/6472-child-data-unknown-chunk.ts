// A child stream 'data' listener whose chunk is unknown or any receives a
// Buffer, or a string when setEncoding ran before the listener registered.
import { spawn } from "node:child_process";

function report(code: number | null, kinds: string[], stdout: string, stderr: string): void {
  console.log("code", code, "kinds", [...new Set(kinds)].join(","));
  console.log("stdout", JSON.stringify(stdout));
  console.log("stderr", JSON.stringify(stderr));
}

function runEncoded(script: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", script], { stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    const kinds: string[] = [];
    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (c: any) => {
        kinds.push(typeof c);
        stdout += c;
      });
    }
    const err = child.stderr;
    if (err !== null) {
      err.setEncoding("utf8");
      err.on("data", (c: unknown) => {
        kinds.push(typeof c);
        stderr += String(c);
      });
    }
    child.on("close", (code) => {
      report(code, kinds, stdout, stderr);
      resolve();
    });
  });
}

function runRaw(script: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", script], { stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    const kinds: string[] = [];
    child.stdout?.on("data", (c: unknown) => {
      kinds.push(Buffer.isBuffer(c) ? "buffer" : typeof c);
      stdout += String(c);
    });
    if (child.stderr) {
      child.stderr.on("data", (c: any) => {
        const chunk = String(c);
        kinds.push(Buffer.isBuffer(c) ? "buffer" : typeof c);
        stderr += chunk;
      });
    }
    child.on("close", (code) => {
      report(code, kinds, stdout, stderr);
      resolve();
    });
  });
}

// setEncoding through one const alias of the stream and the listener
// through another: both name child.stdout, so chunks are strings.
function runAliased(script: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", script], { stdio: "pipe" });
    const encoded = child.stdout!;
    const listened = child.stdout!;
    let stdout = "";
    const kinds: string[] = [];
    encoded.setEncoding("utf8");
    listened.on("data", (c: unknown) => {
      kinds.push(typeof c);
      stdout += String(c);
    });
    child.on("close", (code) => {
      report(code, kinds, stdout, "");
      resolve();
    });
  });
}

runEncoded("printf 'h\\303\\251llo'; echo warn >&2")
  .then(() => runRaw("printf raw; echo oops >&2; exit 2"))
  .then(() => runAliased("printf alias"))
  .then(() => console.log("done"));
