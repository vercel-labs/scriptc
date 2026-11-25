// The order of a child's stdout and stderr 'data' events when both pipes
// fill while the parent waits in its loop: the order the child wrote them,
// whichever stream's listener was attached first. Node serves a turn's
// pipes in the order its kernel queue reports them ready, and so does the
// native loop.
//
// Each child waits for a line on its stdin before it writes. The parent
// sends it from the second of two timers, so it has polled at least once
// since the listeners were attached: the pipes are registered and empty
// when the child writes, on a slow machine as well.
import { spawn } from "node:child_process";

function run(script: string, stderrFirst: boolean): Promise<string> {
  return new Promise((resolve) => {
    const seen: string[] = [];
    const child = spawn("/bin/sh", ["-c", script], { stdio: ["pipe", "pipe", "pipe"] });
    const onStdout = (chunk: Buffer): void => {
      seen.push(`stdout:${chunk.toString().trim()}`);
    };
    const onStderr = (chunk: Buffer): void => {
      seen.push(`stderr:${chunk.toString().trim()}`);
    };
    if (stderrFirst) {
      child.stderr!.on("data", onStderr);
      child.stdout!.on("data", onStdout);
    } else {
      child.stdout!.on("data", onStdout);
      child.stderr!.on("data", onStderr);
    }
    child.on("close", (code) => {
      resolve(`${seen.join(" ")} close:${code}`);
    });
    setTimeout(() => {
      setTimeout(() => {
        child.stdin!.write("go\n");
        child.stdin!.end();
      }, 10);
    }, 10);
  });
}

// Three writes at once, the first and the last to one stream. Whether the
// last one arrives with the first or after the other stream's is timing, in
// Node as well; which stream is heard first and what each delivered is not.
function runThree(script: string): Promise<string> {
  return new Promise((resolve) => {
    const order: string[] = [];
    let out = "";
    let err = "";
    const child = spawn("/bin/sh", ["-c", script], { stdio: ["pipe", "pipe", "pipe"] });
    child.stdout!.on("data", (chunk: Buffer) => {
      if (!order.includes("stdout")) order.push("stdout");
      out += chunk.toString();
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      if (!order.includes("stderr")) order.push("stderr");
      err += chunk.toString();
    });
    child.on("close", (code) => {
      resolve(`first:${order.join(",")} stdout:${JSON.stringify(out)} stderr:${JSON.stringify(err)} close:${code}`);
    });
    setTimeout(() => {
      setTimeout(() => {
        child.stdin!.write("go\n");
        child.stdin!.end();
      }, 10);
    }, 10);
  });
}

async function main(): Promise<void> {
  for (let i = 0; i < 4; i++) console.log("out, err:", await run("read line; echo out; echo err 1>&2; exit 3", false));
  for (let i = 0; i < 4; i++) console.log("err, out:", await run("read line; echo err 1>&2; echo out", false));
  for (let i = 0; i < 2; i++) {
    console.log("out, err, stderr listener first:", await run("read line; echo out; echo err 1>&2", true));
  }
  for (let i = 0; i < 2; i++) {
    console.log("err, out, stderr listener first:", await run("read line; echo err 1>&2; echo out", true));
  }
  console.log("out, err, out:", await runThree("read line; echo a; echo b 1>&2; echo c"));
  console.log("err, out, err:", await runThree("read line; echo a 1>&2; echo b; echo c 1>&2"));
  // Far apart in time: one event per turn, in the order written.
  console.log("slow:", await run("read line; echo one; sleep 0.2; echo two 1>&2; sleep 0.2; echo three", false));
}
main();
