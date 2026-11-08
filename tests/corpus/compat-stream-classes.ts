// node:stream's five classes, built two ways: from an options object and by
// subclassing with the underscore hooks. Covers the events and state
// properties each class documents, Readable.fromWeb, Duplex.from, and the
// error path (a failing transform sets `errored`, emits 'error' and closes).
import { Duplex, PassThrough, Readable, Transform, Writable } from "node:stream";

function ended(stream: Readable): Promise<void> {
  return new Promise((resolve) => {
    stream.on("end", () => resolve());
  });
}
function closed(stream: Readable): Promise<void> {
  return new Promise((resolve) => {
    stream.on("close", () => resolve());
  });
}
function finished(stream: Writable): Promise<void> {
  return new Promise((resolve) => {
    stream.on("finish", () => resolve());
  });
}

// Readable from options: 'data', 'end', 'close', readableEnded, destroyed.
let pulls = 0;
const readable = new Readable({
  read() {
    pulls++;
    this.push(pulls <= 2 ? "c" + pulls : null);
  },
});
readable.setEncoding("utf8");
readable.on("data", (chunk) => console.log("data", chunk));
readable.on("end", () => console.log("end", readable.readableEnded, readable.destroyed));
readable.on("close", () => console.log("close", readable.destroyed));
await closed(readable);

// Readable subclass with _read, consumed by for await.
class Counter extends Readable {
  n = 0;
  _read(): void {
    this.n++;
    this.push(this.n <= 3 ? String(this.n) : null);
  }
}
const counted: string[] = [];
for await (const chunk of new Counter()) counted.push(String(chunk));
console.log(counted.join(","));

// Writable from options: 'finish', writableEnded, writableFinished, writableLength.
const got: string[] = [];
const writable = new Writable({
  write(chunk, _encoding, callback) {
    got.push(chunk.toString());
    callback();
  },
});
writable.on("finish", () =>
  console.log("finish", got.join(""), writable.writableEnded, writable.writableFinished, writable.writableLength),
);
writable.write("a");
writable.end("b");
await finished(writable);

// Writable subclass with _write and _final.
class Sink extends Writable {
  got: string[] = [];
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.got.push(chunk.toString());
    callback();
  }
  _final(callback: (error?: Error | null) => void): void {
    this.got.push("!");
    callback();
  }
}
const sink = new Sink();
sink.on("finish", () => console.log(sink.got.join("")));
sink.write("a");
sink.end("b");
await finished(sink);

// Transform from options.
const shout = new Transform({
  transform(chunk, _encoding, callback) {
    callback(null, chunk.toString().toUpperCase());
  },
});
shout.on("data", (chunk) => console.log(chunk.toString()));
shout.write("ab");
shout.end("cd");
await ended(shout);

// Transform subclass with _transform and _flush.
class Upper extends Transform {
  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.push(chunk.toString().toUpperCase());
    callback();
  }
  _flush(callback: (error?: Error | null) => void): void {
    this.push("!");
    callback();
  }
}
const upper = new Upper();
const shouted: string[] = [];
upper.on("data", (chunk) => shouted.push(chunk.toString()));
upper.on("end", () => console.log(shouted.join("")));
upper.write("ab");
upper.end("cd");
await ended(upper);

// PassThrough, and the 'pipe' event its destination side receives.
const through = new PassThrough();
through.on("pipe", () => console.log("pipe"));
const passed: string[] = [];
through.on("data", (chunk) => passed.push(chunk.toString()));
through.on("end", () => console.log(passed.join("")));
Readable.from(["x", "y"]).pipe(through);
await ended(through);

// Duplex from options: independent readable and writable sides.
const duplex = new Duplex({
  read() {
    this.push("r");
    this.push(null);
  },
  write(chunk, _encoding, callback) {
    console.log("w", chunk.toString());
    callback();
  },
});
duplex.on("data", (chunk) => console.log("d", chunk.toString()));
duplex.write("x");
duplex.end();
console.log(duplex.allowHalfOpen);
await ended(duplex);

// Duplex.from over an iterable.
const joined: string[] = [];
for await (const chunk of Duplex.from(["a", "b"])) joined.push(String(chunk));
console.log(joined.join(""));

// Readable.fromWeb adapts a web ReadableStream.
const web = new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(new Uint8Array([104, 105]));
    controller.close();
  },
});
let adapted = "";
for await (const chunk of Readable.fromWeb(web as any)) adapted += Buffer.from(chunk).toString();
console.log(adapted);

// 'pause', 'resume', readableFlowing and readableLength.
const flowing = Readable.from(["a", "b"]);
flowing.on("pause", () => console.log("pause"));
flowing.on("resume", () => console.log("resume"));
flowing.on("data", () => {});
flowing.on("end", () => console.log("end", flowing.readableFlowing, flowing.readableLength));
flowing.pause();
flowing.resume();
await ended(flowing);

// The error path.
const failing = new Transform({
  transform(_chunk, _encoding, callback) {
    callback(new Error("bad"));
  },
});
failing.on("error", (error) => console.log("error", error.message, failing.errored?.message, failing.destroyed));
failing.on("close", () => console.log("close"));
failing.write("x");
await closed(failing);
