// Several Consoles with detached loggers are still linked into the exit
// cleanup list when the program ends. Releasing one Console's functions can
// run the cycle collector, which can free the next Console on the list: the
// cleanup holds its own reference across each release. A sanitized build
// reports a use-after-free here.
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
// No event-loop turn before exit: the consoles are still on the cleanup
// list when the process tears down.
console.log("total positive", total > 0);
