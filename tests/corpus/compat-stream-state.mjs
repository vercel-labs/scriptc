// State properties and implementer hooks of node:stream classes that the
// class programs do not reach: closed, destroyed, writableCorked,
// writableNeedDrain, the high-water marks and object modes, the
// 'readable' event, compose(), the construct, writev and destroy hooks,
// Transform destroy() and 'finish', and 'unpipe' after an explicit
// unpipe(). Each section finishes before the next starts.
import stream, { PassThrough, Readable, Transform, Writable } from "node:stream";

const finished = (emitter, event) => new Promise((resolve) => emitter.once(event, resolve));
const noop = (_chunk, _encoding, callback) => callback();

// Writable: closed and 'close'.
{
  const writable = new Writable({ write: noop });
  console.log(writable.closed, writable.destroyed);
  const closed = finished(writable, "close");
  writable.end();
  await closed;
  console.log("close", writable.closed, writable.destroyed);
}

// Writable: destroyed, writableCorked, high-water mark and object mode.
{
  const writable = new Writable({ highWaterMark: 5, write: noop });
  const objects = new Writable({ objectMode: true, write: noop });
  console.log(writable.writableHighWaterMark, writable.writableObjectMode, objects.writableHighWaterMark, objects.writableObjectMode);
  console.log(writable.writableCorked);
  writable.cork();
  writable.cork();
  console.log(writable.writableCorked);
  writable.uncork();
  console.log(writable.writableCorked);
  writable.destroy();
  console.log(writable.destroyed);
}

// Writable: writableNeedDrain until 'drain'.
{
  const slow = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      setTimeout(callback, 1);
    },
  });
  console.log(slow.writableNeedDrain);
  slow.write("abc");
  console.log(slow.writableNeedDrain);
  await finished(slow, "drain");
  console.log("drain", slow.writableNeedDrain);
}

// Writable hooks: construct runs before the first write, writev takes the
// corked chunks together, destroy receives the error.
{
  const constructed = new Writable({
    construct(callback) {
      console.log("construct");
      setTimeout(callback, 1);
    },
    write(chunk, _encoding, callback) {
      console.log("write", String(chunk));
      callback();
    },
  });
  constructed.write("a");
  const done = finished(constructed, "finish");
  constructed.end();
  await done;

  const batched = new Writable({
    writev(chunks, callback) {
      console.log("writev", chunks.length, String(chunks[0].chunk), String(chunks[1].chunk));
      callback();
    },
  });
  batched.cork();
  batched.write("a");
  batched.write("b");
  batched.uncork();
  const batchDone = finished(batched, "finish");
  batched.end();
  await batchDone;

  const destroyed = new Writable({
    write: noop,
    destroy(error, callback) {
      console.log("destroy", error);
      callback(error);
    },
  });
  const closed = finished(destroyed, "close");
  destroyed.destroy();
  await closed;
  console.log("destroyed closed");
}

// Readable: readable, closed, high-water mark and object mode.
{
  const readable = new Readable({ highWaterMark: 7, read() {} });
  const objects = new Readable({ objectMode: true, read() {} });
  console.log(readable.readableHighWaterMark, readable.readableObjectMode, objects.readableHighWaterMark, objects.readableObjectMode);
  console.log(readable.readable, readable.closed);
  const closed = finished(readable, "close");
  readable.destroy();
  await closed;
  console.log(readable.readable, readable.closed);
  console.log(new Writable({ write: noop }).writableHighWaterMark, stream.getDefaultHighWaterMark(true));
}

// Readable: the 'readable' event with read().
{
  const source = Readable.from(["a", "b"]);
  const chunks = [];
  source.on("readable", () => {
    let chunk;
    while ((chunk = source.read()) !== null) chunks.push(chunk);
  });
  await finished(source, "end");
  console.log("readable", chunks.join(""));
}

// Readable hooks: construct before the first read, destroy with the error.
{
  const constructed = new Readable({
    construct(callback) {
      console.log("construct");
      callback();
    },
    read() {
      this.push("x");
      this.push(null);
    },
  });
  const seen = [];
  constructed.on("data", (chunk) => seen.push(String(chunk)));
  await finished(constructed, "end");
  console.log("data", seen.join(""));

  const destroyed = new Readable({
    read() {},
    destroy(error, callback) {
      console.log("destroy", error && error.message);
      callback(error);
    },
  });
  const failed = finished(destroyed, "error");
  destroyed.destroy(new Error("stop"));
  console.log("error", (await failed).message);
}

// compose() maps a source through an async generator.
{
  const shouted = Readable.from(["a", "b"]).compose(async function* (source) {
    for await (const chunk of source) yield String(chunk).toUpperCase();
  });
  const out = [];
  for await (const chunk of shouted) out.push(chunk);
  console.log(out.join(""));
}

// Transform: 'finish' before 'end', and destroy() with an error.
{
  const transform = new Transform({
    transform(chunk, _encoding, callback) {
      callback(null, chunk);
    },
  });
  const order = [];
  transform.on("finish", () => order.push("finish"));
  transform.on("end", () => order.push("end"));
  transform.resume();
  transform.end("x");
  await finished(transform, "end");
  console.log(order.join(","));

  const broken = new Transform({
    transform(chunk, _encoding, callback) {
      callback(null, chunk);
    },
  });
  const failed = finished(broken, "error");
  console.log(broken.destroy(new Error("torn")) === broken, broken.destroyed);
  console.log("error", (await failed).message);
}

// 'unpipe' reaches the destination when the source unpipes it.
{
  const source = new PassThrough();
  const destination = new PassThrough();
  destination.on("unpipe", (from) => console.log("unpipe", from === source));
  source.pipe(destination);
  source.unpipe(destination);
}
