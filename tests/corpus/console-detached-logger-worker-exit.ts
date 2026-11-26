// A worker thread tears down its own detached-logger Consoles at exit. The
// cleanup walks the worker's Console list where releasing one Console's
// streams can run the cycle collector over the next, so the walk must hold
// its own references across those releases.
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { Console } from "node:console";
import { Writable } from "node:stream";

interface Sink { out: string }

function streamOf(sink: Sink): Writable {
  return new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      sink.out += String(chunk);
      cb();
    },
  });
}

if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  worker.on("message", (value: number) => console.log("worker made", value));
  worker.on("exit", (code: number) => {
    console.log("worker exit", code);
    process.exit(0);
  });
  setTimeout(() => {
    console.log("timeout");
    process.exit(1);
  }, 2000);
} else {
  let total = 0;
  for (let i = 0; i < 8; i++) {
    const sink: Sink = { out: "" };
    const console = new Console({
      stdout: streamOf(sink),
      stderr: streamOf(sink),
      inspectOptions: { depth: 0 },
    });
    const log = console.log;
    const error = console.error;
    log({ round: i });
    error("round %d", i);
    total += sink.out.length;
  }
  parentPort!.postMessage(total > 0 ? 1 : 0);
}
