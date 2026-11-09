// process.stdin with a 'readable' listener of its own, handed on as a
// Readable that is piped. In Node the listener keeps the stream paused and
// the pipe moves nothing until something reads. The compiled pipe is
// refused by name when it asks for input.
import { Writable } from "node:stream";
import type { Readable } from "node:stream";

function copy(stream: Readable): void {
  const sink = new Writable({
    write(_chunk: Buffer, _encoding, done): void {
      done();
    },
  });
  sink.on("finish", () => console.log("piped"));
  stream.pipe(sink);
}

process.stdin.on("readable", () => {});
copy(process.stdin);
