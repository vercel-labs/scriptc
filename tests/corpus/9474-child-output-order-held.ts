// A child's pipes that outlive it, and stdio shapes with one pipe.
//
// 1. A grandchild keeps both pipes after the child has exited. What the
//    child wrote arrives before its 'exit'; what the grandchild writes
//    later arrives in the order it writes, stderr first here, and 'close'
//    waits for both pipes to end.
// 2. stdio "inherit" next to a pipe: the inherited stream goes straight to
//    the parent's, the piped one is delivered before 'close'.
// 3. A child that points its stderr at its stdout: everything arrives on
//    stdout in the order written, and stderr ends without data.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "scriptc-child-held-"));

function held(): Promise<string> {
  return new Promise((resolve) => {
    const marker = join(dir, "go");
    const seen: string[] = [];
    // The grandchild waits for the marker, which the parent writes two
    // timers after the child's 'exit'.
    const script =
      '(while [ ! -e "$1" ]; do sleep 0.02; done; echo lateerr 1>&2; echo late) & echo early; echo earlyerr 1>&2';
    const child = spawn("/bin/sh", ["-c", script, "sh", marker], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.on("data", (chunk: Buffer) => seen.push(`stdout:${chunk.toString().trim()}`));
    child.stderr!.on("data", (chunk: Buffer) => seen.push(`stderr:${chunk.toString().trim()}`));
    child.on("exit", (code) => {
      seen.push(`exit:${code}`);
      setTimeout(() => {
        setTimeout(() => {
          writeFileSync(marker, "");
        }, 10);
      }, 10);
    });
    child.on("close", (code) => {
      resolve(`${seen.join(" ")} close:${code}`);
    });
  });
}

function inheritStdout(): Promise<string> {
  return new Promise((resolve) => {
    const seen: string[] = [];
    const child = spawn("/bin/sh", ["-c", "echo inherited stdout; echo piped stderr 1>&2"], {
      stdio: ["ignore", "inherit", "pipe"],
    });
    seen.push(`stdout is ${child.stdout === null ? "null" : "a stream"}`);
    child.stderr!.on("data", (chunk: Buffer) => seen.push(`stderr:${chunk.toString().trim()}`));
    child.on("close", (code) => {
      resolve(`${seen.join(", ")}, close:${code}`);
    });
  });
}

function inheritStderr(): Promise<string> {
  return new Promise((resolve) => {
    const seen: string[] = [];
    const child = spawn("/bin/sh", ["-c", "echo piped stdout; echo inherited stderr 1>&2"], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    seen.push(`stderr is ${child.stderr === null ? "null" : "a stream"}`);
    child.stdout!.on("data", (chunk: Buffer) => seen.push(`stdout:${chunk.toString().trim()}`));
    child.on("close", (code) => {
      resolve(`${seen.join(", ")}, close:${code}`);
    });
  });
}

function merged(): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    const child = spawn("/bin/sh", ["-c", "exec 2>&1; echo out; echo err 1>&2; echo out2"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.on("close", (code) => {
      resolve(`stdout:${JSON.stringify(out)} stderr:${JSON.stringify(err)} close:${code}`);
    });
  });
}

async function main(): Promise<void> {
  console.log("held:", await held());
  console.log("inherit stdout:", await inheritStdout());
  console.log("inherit stderr:", await inheritStderr());
  console.log("merged:", await merged());
  rmSync(dir, { recursive: true, force: true });
}
main();
