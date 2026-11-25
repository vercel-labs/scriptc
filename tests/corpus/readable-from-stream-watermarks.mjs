// Readable.from over a stream: a highWaterMark of 0 is legal, and a sized
// read grows the watermark to the smallest power of two at least the
// request (readable.js's computeNewHighWaterMark), so a read never spins on
// a zero watermark. The parsed option flags reach the native fast path, so
// objectMode: false builds a byte-mode wrapper.
import { PassThrough, Readable } from "node:stream";

// highWaterMark: 0 with a positive-sized read, object mode
{
  const readable = Readable.from(Readable.from(["a", "b"]), { highWaterMark: 0 });
  console.log("object hwm", readable.readableHighWaterMark, readable.readableObjectMode);
  const first = readable.read(1);
  const out = [];
  for await (const chunk of readable) out.push(String(chunk));
  console.log("object chunks", String(first), out.join(","), "grown", readable.readableHighWaterMark);
}

// highWaterMark: 0 with a sized read larger than one byte, byte mode
{
  const source = Readable.from([Buffer.from("abc")]);
  const readable = Readable.from(source, { objectMode: false, highWaterMark: 0 });
  console.log("byte hwm", readable.readableHighWaterMark, readable.readableObjectMode);
  const first = readable.read(2);
  const out = [];
  for await (const chunk of readable) out.push(String(chunk));
  console.log("byte chunks", String(first), out.join("|"), "grown", readable.readableHighWaterMark);
}

// objectMode: false without a highWaterMark keeps Node's stream default of 1
{
  const readable = Readable.from(Readable.from(["x"]), { objectMode: false });
  console.log("byte mode", readable.readableObjectMode, readable.readableHighWaterMark);
  const out = [];
  for await (const chunk of readable) out.push(String(chunk));
  console.log("byte mode chunks", out.join(","));
}

// a sized read grows a non-zero watermark the same way: the smallest power
// of two at least the request, whatever the current watermark
{
  const readable = Readable.from(Readable.from(["a", "b"]), { highWaterMark: 3 });
  console.log("odd hwm", readable.readableHighWaterMark, readable.readableObjectMode);
  const first = readable.read(5);
  console.log("odd read", String(first), "grown", readable.readableHighWaterMark);
  readable.destroy();
}

// an empty wrapper's read(0) emits nothing while the watermark is 0
{
  const source = new PassThrough({ objectMode: true });
  const readable = Readable.from(source, { highWaterMark: 0 });
  let emitted = 0;
  readable.on("readable", () => emitted++);
  readable.read(0);
  await new Promise((resolve) => setImmediate(resolve));
  console.log("empty read0", emitted, readable.readableHighWaterMark);
  source.write("late");
  await new Promise((resolve) => setImmediate(resolve));
  console.log("after write", emitted, readable.readableHighWaterMark);
  console.log("late chunk", String(readable.read(1)), "grown", readable.readableHighWaterMark);
  source.end();
}
