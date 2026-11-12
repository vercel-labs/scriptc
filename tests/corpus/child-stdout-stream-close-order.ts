// A child's output pipes seen as general streams (through `unknown`): the
// child's 'close' waits for each stream's own 'end' and 'close', and the
// child's exit resumes a stream the program never reads, as Node's
// flushStdio does, so 'close' still follows. Exit and a pipe's end can
// arrive in either order, so each child reports what it saw at 'close'.
// The child's own listener on each stream comes first, as in Node: when
// the exit comes first (the unread case), the child's 'close' fires inside
// the last stream's 'close', before the program's listener on it.
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

function asStream(stream: Readable | null): Readable {
  const value: unknown = stream;
  if (value === null) throw new Error("missing pipe");
  return value as Readable;
}

type Seen = { exited: boolean; ended: number; closed: number; text: string };

function start(name: string, script: string, report: (seen: Seen) => string): [ChildProcess, Seen] {
  const child = spawn("node", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  const seen: Seen = { exited: false, ended: 0, closed: 0, text: "" };
  child.on("exit", (code) => {
    seen.exited = true;
    if (code !== 0) console.log(name, "exit", code);
  });
  child.on("close", (code) => {
    console.log(name, "close", code, seen.exited, report(seen));
    next();
  });
  return [child, seen];
}

function watch(stream: Readable, seen: Seen): void {
  stream.on("end", () => { seen.ended++; });
  stream.on("close", () => { seen.closed++; });
}

const steps: Array<() => void> = [
  () => {
    // Both pipes read with 'data': both end and close before the child's 'close'.
    const [child, seen] = start(
      "data",
      "process.stdout.write('hi'); process.stderr.write('oops')",
      (s) => `ended=${s.ended} text=${JSON.stringify(s.text)}`,
    );
    const out = asStream(child.stdout);
    const err = asStream(child.stderr);
    out.on("data", (chunk: Buffer) => { seen.text += chunk.toString(); });
    err.on("data", (chunk: Buffer) => { seen.text += chunk.toString().toUpperCase(); });
    watch(out, seen);
    watch(err, seen);
  },
  () => {
    // Never read: the exit resumes both streams, and 'close' follows.
    const [child, seen] = start(
      "unread",
      "process.stdout.write('x'.repeat(5000)); process.stderr.write('e')",
      (s) => `ended=${s.ended} closed=${s.closed}`,
    );
    const out = asStream(child.stdout);
    const err = asStream(child.stderr);
    console.log("unread readable", out.readable, err.readable, out.readableFlowing);
    watch(out, seen);
    watch(err, seen);
  },
  () => {
    // Paused with a 'data' listener: nothing flows until the exit resumes it.
    const [child, seen] = start(
      "paused",
      "process.stdout.write('later')",
      (s) => `ended=${s.ended} text=${JSON.stringify(s.text)}`,
    );
    const out = asStream(child.stdout);
    out.on("data", (chunk: Buffer) => {
      if (!seen.exited) console.log("paused data before exit");
      seen.text += chunk.toString();
    });
    out.pause();
    watch(out, seen);
  },
  () => {
    // Read with 'readable' and read(): the exit leaves it to the program.
    const [child, seen] = start(
      "readable",
      "process.stdout.write('pulled')",
      (s) => `ended=${s.ended} text=${JSON.stringify(s.text)}`,
    );
    const out = asStream(child.stdout);
    out.on("readable", () => {
      let chunk: Buffer | null;
      while ((chunk = out.read() as Buffer | null) !== null) seen.text += chunk.toString();
    });
    watch(out, seen);
  },
];

function next(): void {
  const step = steps.shift();
  if (step !== undefined) step();
  else console.log("done");
}
next();
