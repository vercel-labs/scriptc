// A detached Console instance output method publishes on the same
// diagnostics_channel channel a direct call publishes on. The loop below
// also builds the request-scoped logger whose method listens on the stream
// the logger owns, so the sanitized lane's RC audit covers that shape.
import { Console } from "node:console";
import { channel } from "node:diagnostics_channel";
import { Writable } from "node:stream";

interface Sink {
  stream: Writable;
  text: () => string;
}

function sink(): Sink {
  let out = "";
  const stream = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      out += String(chunk);
      cb();
    },
  });
  return { stream, text: () => out };
}

const seen: string[] = [];
function record(message: unknown, name: unknown): void {
  seen.push(`${String(name)} ${JSON.stringify(message)}`);
}
channel("console.log").subscribe(record);
channel("console.error").subscribe(record);

const out = sink();
const err = sink();
const instance = new Console({ stdout: out.stream, stderr: err.stream });
const log = instance.log;
const fail = instance.error;
log("detached", 1);
fail("detached error");
instance.log("direct");
channel("console.log").unsubscribe(record);
channel("console.error").unsubscribe(record);
log("after unsubscribe");
console.log(JSON.stringify(seen));
console.log("streams", JSON.stringify(out.text()), JSON.stringify(err.text()));

function request(): number {
  const target = sink();
  const errors = sink();
  const console = new Console({ stdout: target.stream, stderr: errors.stream });
  const error = console.error;
  target.stream.on("round", error);
  target.stream.emit("round");
  return errors.text().length;
}

let total = 0;
for (let i = 0; i < 200; i++) total += request();
await new Promise<void>((resolve) => setTimeout(resolve, 0));
console.log("detached errors", total > 0);
