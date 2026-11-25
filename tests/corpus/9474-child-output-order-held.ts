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
// 4. A spawn that fails: 'error' is a next-tick event and comes before the
//    pipes' 'end', from ordinary code and from inside another child's
//    listeners. Which pipe ends first is the kernel's order. On Linux a
//    failed spawn returns when the child that could not start has been
//    waited for: both pipes are at end-of-file by then and end in the order
//    they were created, stdout before stderr. On Darwin posix_spawn returns
//    while the kernel still takes that child down, the two pipes reach
//    end-of-file a moment later in either order, and Node hands them on as
//    they come, stderr first in some runs. There the two 'end' events are
//    recorded without their names, and 'close' names what ended.
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

// Whether a failed spawn's pipes end in the order they were created (4 above).
const failedPipesEndInOrder = process.platform !== "darwin";

function failing(seen: string[], done: () => void): void {
  const child = spawn("definitely-not-a-binary-zzz", ["x"], { stdio: ["ignore", "pipe", "pipe"] });
  const ended: string[] = [];
  const end = (name: string): void => {
    ended.push(name);
    seen.push(failedPipesEndInOrder ? `${name} end` : "end");
  };
  child.stdout!.on("data", () => seen.push("data"));
  child.stdout!.on("end", () => end("stdout"));
  child.stderr!.on("end", () => end("stderr"));
  child.on("error", (err) => seen.push(`error ${err.message.split(" ").pop()}`));
  child.on("exit", () => seen.push("exit"));
  child.on("close", (code) => {
    if (!failedPipesEndInOrder) seen.push(`ended ${ended.sort().join(" and ")}`);
    seen.push(`close:${code}`);
    done();
  });
}

function failed(from: "start" | "exit" | "data"): Promise<string> {
  return new Promise((resolve) => {
    const seen: string[] = [];
    const done = (): void => resolve(seen.join(", "));
    if (from === "start") {
      failing(seen, done);
      return;
    }
    const first = spawn("/bin/sh", ["-c", "echo out"], { stdio: ["ignore", "pipe", "pipe"] });
    first.stdout!.on("data", () => {
      seen.push("first data");
      if (from === "data") failing(seen, done);
    });
    // When the first child's 'exit' falls relative to the failed one's pipes
    // is timing, so it is recorded only where it starts the failed spawn.
    first.on("exit", () => {
      if (from !== "exit") return;
      seen.push("first exit");
      failing(seen, done);
    });
  });
}

async function main(): Promise<void> {
  console.log("held:", await held());
  console.log("inherit stdout:", await inheritStdout());
  console.log("inherit stderr:", await inheritStderr());
  console.log("merged:", await merged());
  console.log("failed spawn:", await failed("start"));
  console.log("failed spawn in an exit listener:", await failed("exit"));
  console.log("failed spawn in a data listener:", await failed("data"));
  rmSync(dir, { recursive: true, force: true });
}
main();
