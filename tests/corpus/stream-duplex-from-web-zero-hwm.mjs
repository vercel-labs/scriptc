// Duplex.fromWeb's runtime highWaterMark reaches the native readable: a sized
// read on a zero watermark grows the watermark to the next power of two above
// the size, as Node's computeNewHighWaterMark does, instead of looping on it.
import { Duplex } from "node:stream";

const enc = new TextEncoder();
const readable = new ReadableStream({
  start(controller) {
    controller.enqueue(enc.encode("hello"));
    controller.close();
  },
});
const writable = new WritableStream({ write() {} });
const duplex = Duplex.fromWeb({ readable, writable }, { highWaterMark: 0 });

console.log("hwm", duplex.readableHighWaterMark, "rm", duplex.readableObjectMode);
const chunk = duplex.read(3);
console.log("read", chunk === null ? "null" : Buffer.from(chunk).toString(), "hwm", duplex.readableHighWaterMark);
