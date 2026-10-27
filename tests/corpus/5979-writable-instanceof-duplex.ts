// `x instanceof Writable` answers true for Duplex streams and their
// subclasses, as Node's Writable[Symbol.hasInstance] does. Subclasses of
// Writable keep the prototype test.
import { Duplex, PassThrough, Readable, Transform, Writable } from "node:stream";
import * as zlib from "node:zlib";
import { EventEmitter } from "node:events";

class Sink extends Writable {
  override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    callback();
  }
}
class Pipe extends Duplex {
  override _read(): void {}
  override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    callback();
  }
}
class Upper extends Transform {
  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error: Error | null, data?: string) => void,
  ): void {
    callback(null, chunk.toString().toUpperCase());
  }
}

const writable = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});
const duplex = new Duplex({
  read() {},
  write(_chunk, _encoding, callback) {
    callback();
  },
});
const pass = new PassThrough();
const transform = new Transform({
  transform(chunk, _encoding, callback) {
    callback(null, chunk);
  },
});
const readable = new Readable({ read() {} });

console.log("writable", writable instanceof Writable, new Sink() instanceof Writable);
console.log(
  "duplex family",
  duplex instanceof Writable,
  pass instanceof Writable,
  transform instanceof Writable,
  new Pipe() instanceof Writable,
  new Upper() instanceof Writable,
  zlib.createGzip() instanceof Writable,
);
console.log("readable", readable instanceof Writable, readable instanceof Duplex);
console.log("subclass of writable", pass instanceof Sink, duplex instanceof Sink, new Sink() instanceof Sink);

const asReadable: Readable = pass;
const asEmitter: EventEmitter = new Pipe();
const plainEmitter: EventEmitter = new EventEmitter();
console.log("base-typed", asReadable instanceof Writable, asEmitter instanceof Writable, plainEmitter instanceof Writable);

function describe(value: Readable | string): string {
  return value instanceof Writable ? "writable side" : "no writable side";
}
console.log("union", describe(duplex), describe(readable), describe("text"));

try {
  throw transform;
} catch (err) {
  console.log("caught", err instanceof Writable, err instanceof Readable);
}
