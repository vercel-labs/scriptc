// A paused output stream of an exec() child and the call's maxBuffer. The
// child writes far more than the limit. Under Node the paused stream stops
// reading, the child blocks, and the limit ends it once the stream is
// resumed: the callback gets the maxBuffer error and the output cut at the
// limit, and the command after the writer never runs. A runtime that keeps
// reading a paused stream for the callback must count the limit while it
// reads, or the child writes everything and the parent holds all of it.
//
// What the callback's output holds is printed as "at least the limit", not
// as a length. When the paused stream held more than one chunk, Node hands
// the later ones to exec's listener after the cut, and that listener's
// arithmetic then keeps part of a chunk it should drop: the same program
// gave 1,024 characters in most runs and 59,392 in one. The error, the
// limit having been reached and the writer never finishing do not vary.
import { exec } from "node:child_process";

function describe(error: Error | null): string {
  if (error === null) return "null";
  const e = error as Error & { code?: string };
  return `${e.name} ${e.code}`;
}

function paused(command: string, maxBuffer: number, pauseStderr: boolean): Promise<string> {
  return new Promise((resolve) => {
    const child = exec(command, { maxBuffer }, (error, stdout, stderr) => {
      const held = pauseStderr ? stderr.length : stdout.length;
      const other = pauseStderr ? stdout.length : stderr.length;
      const reached = held === 0 || held >= maxBuffer ? held >= maxBuffer : held;
      resolve(`${describe(error)} limit reached: ${reached}, other stream: ${other}`);
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
  // Output under the limit is all there, paused or not: six characters of
  // stdout (printed as they are under the limit) and three of stderr.
  console.log("under:", await paused("printf abcdef; printf uvw >&2", 1024, false));
}

void main();
