// A byte-mode stream's write chunks are Buffers: an underscore method
// whose chunk parameter has another type is fenced, and super(undefined)
// passes no options, so the stream is in byte mode. A parameter that
// admits the Buffer (Buffer | string) is not fenced, inline or as a
// method.
import { Writable } from "node:stream";

class Numbers extends Writable {
  constructor() {
    super(undefined);
  }
  _write(chunk: number, _encoding: BufferEncoding, cb: (err?: Error | null) => void): void {
    console.log(chunk);
    cb();
  }
}
new Numbers().end("x");

const accepted = new Writable({
  write(chunk: Buffer | string, _encoding: BufferEncoding, cb: (err?: Error | null) => void): void {
    console.log(typeof chunk === "string" ? chunk : chunk.toString());
    cb();
  },
});
accepted.end("z");

class Wide extends Writable {
  constructor() {
    super(undefined);
  }
  _write(chunk: Buffer | string, _encoding: BufferEncoding, cb: (err?: Error | null) => void): void {
    console.log(typeof chunk === "string" ? chunk : chunk.toString());
    cb();
  }
}
new Wide().end("w");
