// Readable.toWeb keeps a backpressured source flowing: a PassThrough with a
// one-byte highWaterMark holds each write until the web reader takes the
// chunk, then completes the write callback and the drain Node's writable
// side expects. Without the adapter's read demand the write and its drain
// wait forever after the first chunk.
import { PassThrough, Readable } from "node:stream";

const log = [];
const pass = new PassThrough({ highWaterMark: 1 });
const reader = Readable.toWeb(pass).getReader();

function write(text) {
  return new Promise((resolve) => pass.write(Buffer.from(text), () => resolve(undefined)));
}

const first = reader.read();
const firstWrite = write("hello world");
const chunk = await first;
await firstWrite;
log.push(
  `first ${Buffer.from(chunk.value ?? new Uint8Array()).toString()} len ${pass.readableLength} drain ${pass.writableNeedDrain}`,
);

const second = reader.read();
const secondWrite = write("again");
const chunk2 = await second;
await secondWrite;
log.push(
  `second ${Buffer.from(chunk2.value ?? new Uint8Array()).toString()} len ${pass.readableLength} drain ${pass.writableNeedDrain}`,
);

await reader.cancel();

for (const line of log) console.log(line);
