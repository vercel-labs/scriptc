// Request-scoped Consoles with detached loggers: the instance holds its
// bound methods and each method holds the instance, so every request leaks
// the pair unless the cycle collector sees both edges. Under the sanitized
// lane's RC audit a Console still live at exit fails the run.
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

function request(i: number): number {
  const sink: Sink = { out: "" };
  const console = new Console({ stdout: streamOf(sink), inspectOptions: { depth: 0 } });
  const log = console.log;
  const error = console.error;
  log({ request: i });
  error("done %d", i);
  return sink.out.length;
}

let total = 0;
for (let i = 0; i < 500; i++) total += request(i);
console.log("total", total);
