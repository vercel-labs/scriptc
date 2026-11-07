// node:stream's utility predicates: isDestroyed, isErrored, isDisturbed,
// isReadable and isWritable, and Readable.isDisturbed. Each stream is
// asked where it was created and again through a function parameter, at
// every point of its life the predicates tell apart. Primitives take the
// answers Node's duck typing gives a value with none of the properties.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import stream, { Duplex, PassThrough, Readable, Transform, Writable } from "node:stream";
import zlib from "node:zlib";

const turn = () => new Promise((resolve) => setImmediate(resolve));
const noop = (_chunk, _encoding, callback) => callback();

// The five answers for a value that arrives untyped.
function untyped(value) {
  return [
    stream.isDestroyed(value),
    stream.isErrored(value),
    stream.isDisturbed(value),
    stream.isReadable(value),
    stream.isWritable(value),
  ].join(" ");
}

// Readable: untouched, flowing, ended and destroyed.
{
  const readable = Readable.from(["a", "b"]);
  console.log("readable new", stream.isDestroyed(readable), stream.isErrored(readable), stream.isDisturbed(readable));
  console.log("readable new", stream.isReadable(readable), stream.isWritable(readable));
  console.log("readable new untyped", untyped(readable));
  readable.on("data", () => {});
  readable.once("end", () => {
    console.log("readable end", stream.isDestroyed(readable), stream.isDisturbed(readable), stream.isReadable(readable));
    console.log("readable end untyped", untyped(readable));
  });
  await turn();
  await turn();
  console.log("readable closed", stream.isDestroyed(readable), stream.isErrored(readable), stream.isDisturbed(readable));
  console.log("readable closed", stream.isReadable(readable), stream.isWritable(readable));
  console.log("readable closed untyped", untyped(readable));
}

// Readable: read() disturbs, and so does a destroy before 'end'.
{
  const read = new Readable({ read() {} });
  read.push("x");
  console.log("read before", stream.isDisturbed(read), Readable.isDisturbed(read));
  read.read();
  console.log("read after", stream.isDisturbed(read), Readable.isDisturbed(read), untyped(read));
  read.destroy();

  const aborted = new Readable({ read() {} });
  console.log("aborted before", stream.isDisturbed(aborted), stream.isReadable(aborted));
  aborted.destroy();
  console.log("aborted after", stream.isDisturbed(aborted), stream.isReadable(aborted), stream.isDestroyed(aborted));
  console.log("aborted untyped", untyped(aborted));
  await turn();
}

// Writable: no readable side, so isReadable is null; ended, then closed.
{
  const writable = new Writable({ write: noop });
  console.log("writable new", stream.isDestroyed(writable), stream.isErrored(writable), stream.isDisturbed(writable));
  console.log("writable new", stream.isReadable(writable), stream.isWritable(writable));
  console.log("writable new untyped", untyped(writable));
  writable.end("x");
  console.log("writable ended", stream.isWritable(writable), stream.isDestroyed(writable), untyped(writable));
  await turn();
  console.log("writable closed", stream.isWritable(writable), stream.isDestroyed(writable), untyped(writable));
}

// Duplex kinds: both sides, each ending on its own.
{
  const through = new PassThrough();
  console.log("through new", stream.isReadable(through), stream.isWritable(through), untyped(through));
  through.end("x");
  console.log("through ended", stream.isReadable(through), stream.isWritable(through), untyped(through));
  through.resume();
  await turn();
  console.log("through closed", stream.isReadable(through), stream.isWritable(through), untyped(through));

  const duplex = new Duplex({ read() {}, write: noop });
  console.log("duplex", untyped(duplex), Duplex.isDisturbed(duplex));
  duplex.destroy();
  console.log("duplex destroyed", untyped(duplex), Duplex.isDisturbed(duplex));

  const transform = new Transform({
    transform(chunk, _encoding, callback) {
      callback(null, chunk);
    },
  });
  transform.write("x");
  console.log("transform", untyped(transform), Transform.isDisturbed(transform));
  transform.read();
  console.log("transform read", untyped(transform), PassThrough.isDisturbed(transform));
  transform.destroy();
  await turn();
}

// A subclass answers as its base does.
{
  class Counter extends Readable {
    count = 0;
    _read() {
      this.count += 1;
      this.push(this.count > 2 ? null : String(this.count));
    }
  }
  const counter = new Counter();
  console.log("subclass new", stream.isReadable(counter), stream.isWritable(counter), untyped(counter));
  counter.resume();
  await turn();
  await turn();
  console.log("subclass closed", stream.isReadable(counter), stream.isDisturbed(counter), untyped(counter));
}

// Streams the runtime builds: a zlib Transform and the fs streams.
{
  const gzip = zlib.createGzip();
  console.log("gzip", untyped(gzip), stream.isReadable(gzip), stream.isWritable(gzip));
  gzip.destroy();

  const file = path.join(os.tmpdir(), `compat-stream-predicates-${process.pid}.txt`);
  const sink = fs.createWriteStream(file);
  console.log("file sink", untyped(sink), stream.isWritable(sink), Writable.isDisturbed(sink));
  await new Promise((resolve) => sink.end("contents", resolve));
  console.log("file sink ended", untyped(sink));
  const source = fs.createReadStream(file);
  console.log("file source", untyped(source), stream.isReadable(source), stream.isDisturbed(source));
  source.resume();
  await new Promise((resolve) => source.once("close", resolve));
  console.log("file source closed", untyped(source), stream.isDisturbed(source));
  fs.unlinkSync(file);
}

// isErrored turns true when 'error' is emitted, not when destroy(err)
// returns.
{
  const failing = new PassThrough();
  failing.on("error", (error) => {
    console.log("error event", error.message, stream.isErrored(failing), untyped(failing));
  });
  failing.destroy(new Error("boom"));
  console.log("after destroy(err)", stream.isErrored(failing), stream.isDestroyed(failing), untyped(failing));
  await turn();
  console.log("after error", stream.isErrored(failing), untyped(failing));

  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error("write failed"));
    },
  });
  sink.on("error", (error) => console.log("sink error", error.message, stream.isErrored(sink), stream.isWritable(sink)));
  sink.write("x");
  console.log("sink after write", stream.isErrored(sink), stream.isWritable(sink));
  await turn();
  console.log("sink settled", stream.isErrored(sink), stream.isWritable(sink), untyped(sink));
}

// Primitives: nothing to read, so null for the side questions and false
// for the others.
for (const value of [undefined, null, 0, 1, "", "text", true, false, 10n, Symbol("s")]) {
  console.log(typeof value, String(value), untyped(value));
}
console.log("literal", stream.isDestroyed(null), stream.isErrored(undefined), stream.isDisturbed(1));
console.log("literal", stream.isReadable("text"), stream.isWritable(false), Readable.isDisturbed(null));
console.log("literal", stream.isDestroyed(10n), stream.isErrored(10n), stream.isDisturbed(10n));
console.log("literal", stream.isReadable(Symbol("r")), stream.isWritable(Symbol("w")));
