// A backpressured decompression flush waits for readable pulls once its
// queued output reaches the bound. Cancelling the reader then must settle
// the stream: the close promise rejects with the cancel reason (as in Node),
// the cancellation itself resolves, and the engine is released.
import { gzipSync } from "node:zlib";

const size = 8 * 1024 * 1024;
const compressed = new Uint8Array(gzipSync(Buffer.alloc(size)));
const stream = new DecompressionStream("gzip");
const writer = stream.writable.getWriter();
const reader = stream.readable.getReader();
await writer.write(compressed);
const close = writer.close();
const first = await reader.read();
console.log("first", (first.value as Uint8Array).length, first.done);
await reader.cancel("stop");
try {
  await close;
  console.log("close resolved");
} catch (error) {
  console.log("close rejected", String(error));
}
console.log("done");
