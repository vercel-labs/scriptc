// Large writes to one of a child's pipes and a short write to the other. A
// pipe that was readable first is served first and keeps its turn while it
// still holds data, so the short write on the other stream is heard only
// after every byte written before it, in Node and natively.
//
// The child waits for a line on its stdin, sent from the second of two
// timers, so the parent has polled since the listeners were attached (see
// 9471-child-output-order-ready.ts). Chunk sizes differ between a pipe and
// Node's socket pair, so the program prints totals, never chunks.
import { spawn } from "node:child_process";

function run(script: string): Promise<string> {
  return new Promise((resolve) => {
    let outBytes = 0;
    let errBytes = 0;
    const first: string[] = [];
    const child = spawn("/bin/sh", ["-c", script], { stdio: ["pipe", "pipe", "pipe"] });
    child.stdout!.on("data", (chunk: Buffer) => {
      if (outBytes === 0) first.push(`stdout first heard after ${errBytes} stderr bytes`);
      outBytes += chunk.length;
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      if (errBytes === 0) first.push(`stderr first heard after ${outBytes} stdout bytes`);
      errBytes += chunk.length;
    });
    child.on("close", (code) => {
      resolve(`${first.join(", ")}; stdout ${outBytes}, stderr ${errBytes}, close:${code}`);
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
  // 300000 bytes to stdout, then a line to stderr.
  console.log(await run("read line; head -c 300000 /dev/zero; echo err 1>&2"));
  // The other way round.
  console.log(await run("read line; head -c 300000 /dev/zero 1>&2; echo out"));
  // The short line first: it is alone in the queue when it is written.
  console.log(await run("read line; echo err 1>&2; sleep 0.2; head -c 300000 /dev/zero"));
  console.log(await run("read line; echo out; sleep 0.2; head -c 300000 /dev/zero 1>&2"));
}
main();
