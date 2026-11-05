// Streams dropped before they end, after their option callbacks ran: a
// Writable, an object-mode Transform read in part, and a Writable whose
// destroy() never calls back. Each stream keeps the last `callback` it
// passed, which holds the stream, so dropping one leaves a cycle; the
// sanitized lane's exit audit checks that it is reclaimed.
import { Readable, Transform, Writable } from "node:stream";

type Done = (error?: Error | null) => void;

let written = 0;
function writeSome(n: number): void {
  const w = new Writable({
    write(_chunk: Buffer, _encoding: string, callback: Done) {
      written++;
      callback();
    },
  });
  for (let i = 0; i < n; i++) w.write("x");
}

let transformed = 0;
function transformSome(): void {
  const t = new Transform({
    objectMode: true,
    transform(chunk: number, _encoding: string, callback: (error?: Error | null, data?: number) => void) {
      transformed++;
      callback(null, chunk * 2);
    },
  });
  Readable.from([1, 2, 3, 4, 5, 6]).pipe(t);
  t.once("data", (value: number) => console.log("first", value));
}

function destroyNoCallback(): void {
  const w = new Writable({
    write(_chunk: Buffer, _encoding: string, callback: Done) {
      callback();
    },
    destroy(_error: Error | null, _callback: Done) {
      console.log("destroy called");
    },
  });
  w.write("y", () => {
    w.destroy();
    console.log("destroyed", w.destroyed, w.closed);
  });
}

for (let i = 0; i < 20; i++) writeSome(5);
transformSome();
destroyNoCallback();
setImmediate(() => {
  setImmediate(() => console.log("written", written, "transformed", transformed));
});
