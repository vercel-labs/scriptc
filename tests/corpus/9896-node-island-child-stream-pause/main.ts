// @requires-libnode
// pause(), resume(), isPaused() and readableFlowing on the stdout of a child process a Node
// island started are the island stream's own: a paused stream delivers nothing until it is
// resumed, and the flow state reads as Node's. The child prints a line, waits for a line on its
// stdin, prints the next one, and so on, so each chunk arrives only after the program asked for it.
import type { ChildProcess } from "node:child_process";
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

const child: ChildProcess = lib.start();
const out = child.stdout;
const log: string[] = [];
let bytes = 0;

function state(): string {
  return `paused=${out?.isPaused()} flowing=${out?.readableFlowing} bytes=${bytes}`;
}

if (out) {
  log.push(`start ${state()}`);
  out.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    log.push(`data ${JSON.stringify(chunk.toString())} ${state()}`);
    if (bytes === 4) {
      out.pause();
      log.push(`pause ${state()}`);
      // The child prints its second line now; the paused stream holds it.
      child.stdin?.write("go\n");
      setTimeout(() => {
        log.push(`still paused ${state()}`);
        out.resume();
        log.push(`resume ${state()}`);
      }, 300);
    } else if (bytes === 8) {
      child.stdin?.write("go\n");
      child.stdin?.end();
    }
  });
  log.push(`listening ${state()}`);
}
child.on("close", (code) => {
  log.push(`close ${code} ${state()}`);
  for (const line of log) console.log(line);
});
