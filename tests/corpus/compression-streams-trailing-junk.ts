// Bytes after the end of the compressed stream are the trailing-junk
// error, for every decompression format: a close rejects with
// ERR_TRAILING_JUNK_AFTER_STREAM_END and the readable rejects with Node's
// TypeError carrying the code and the message, whether the junk follows a
// short stream, a second gzip member, or zero padding.

import { deflateSync, gzipSync } from "node:zlib";

function describe(error: unknown): string {
  const e = error as Error & { code?: string };
  return `${e.name} ${e.code} ${JSON.stringify(e.message)}`;
}

async function closedWithJunk(label: string, bytes: Uint8Array): Promise<void> {
  const stream = new DecompressionStream("gzip");
  const writer = stream.writable.getWriter();
  let wrote = "write ok";
  try {
    await writer.write(bytes);
  } catch (error) {
    wrote = `write ${describe(error)}`;
  }
  let closed = "close ok";
  try {
    await writer.close();
  } catch (error) {
    closed = `close ${describe(error)}`;
  }
  const reader = stream.readable.getReader();
  let read = "";
  let chunks = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks += 1;
    }
    read = `read done ${chunks}`;
  } catch (error) {
    read = `read ${describe(error)} ${chunks}`;
  }
  console.log(label, wrote, closed, read);
}

const good = gzipSync(Buffer.from("alpha"));
await closedWithJunk("after stream", Buffer.concat([good, Buffer.from("junk")]));
await closedWithJunk("second member", Buffer.concat([good, gzipSync(Buffer.from("beta"))]));
await closedWithJunk("zero padding", Buffer.concat([good, Buffer.alloc(8)]));

// A reader that is already waiting still receives the stream's bytes before
// the error: the junk is only reached after the last output chunk.
const payload = Buffer.alloc(100_000, 0x61);
const stream = new DecompressionStream("gzip");
const writer = stream.writable.getWriter();
const reader = stream.readable.getReader();
const reading = (async () => {
  let total = 0;
  let chunks = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return `done ${chunks} ${total}`;
      chunks += 1;
      total += value.length;
    }
  } catch (error) {
    return `${describe(error)} after ${chunks} ${total}`;
  }
})();
let wrote = "write ok";
try {
  await writer.write(new Uint8Array(Buffer.concat([gzipSync(payload), Buffer.from("junk")])));
} catch (error) {
  wrote = `write ${describe(error)}`;
}
const read = await reading;
let closed = "close ok";
try {
  await writer.close();
} catch (error) {
  closed = `close ${describe(error)}`;
}
console.log("slow reader", wrote, read, closed);

// deflate-raw rejects too.
const raw = new DecompressionStream("deflate-raw");
const rawWriter = raw.writable.getWriter();
const rawReader = raw.readable.getReader();
try {
  await rawWriter.write(new Uint8Array(Buffer.concat([deflateSync(Buffer.from("raw")), Buffer.from("junk")])));
  await rawWriter.close();
  console.log("deflate-raw write+close ok");
} catch (error) {
  console.log("deflate-raw", describe(error));
}
try {
  for (;;) {
    const { done } = await rawReader.read();
    if (done) break;
  }
  console.log("deflate-raw read done");
} catch (error) {
  console.log("deflate-raw read", describe(error));
}
