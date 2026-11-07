// A paused output stream of an exec() child and the call's maxBuffer. The
// child writes far more than the limit. Under Node the paused stream stops
// reading, the child blocks, and the limit ends it once the stream is
// resumed: the callback gets the maxBuffer error and the output cut at the
// limit, and the command after the writer never runs. A runtime that keeps
// reading a paused stream for the callback must count the limit while it
// reads, or the child writes everything and the parent holds all of it.
import { exec } from "node:child_process";

function describe(error: Error | null): string {
  if (error === null) return "null";
  const e = error as Error & { code?: string };
  return `${e.name} ${e.code}`;
}

function paused(command: string, maxBuffer: number, pauseStderr: boolean): Promise<string> {
  return new Promise((resolve) => {
    const child = exec(command, { maxBuffer }, (error, stdout, stderr) => {
      resolve(`${describe(error)} stdout=${stdout.length} stderr=${stderr.length}`);
    });
    const stream = pauseStderr ? child.stderr! : child.stdout!;
    stream.pause();
    setTimeout(() => {
      stream.resume();
    }, 300);
  });
}

async function main(): Promise<void> {
  console.log("stdout:", await paused("head -c 20000000 /dev/zero; echo done >&2", 1024, false));
  console.log("stderr:", await paused("head -c 20000000 /dev/zero >&2; echo done", 2048, true));
  // Output under the limit is all there, paused or not.
  console.log("under:", await paused("printf abcdef; printf uvw >&2", 1024, false));
}

void main();
