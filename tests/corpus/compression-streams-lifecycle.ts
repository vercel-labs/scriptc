// Short-lived compression streams release what they hold: a stream that is
// closed, one that errors, one that is cancelled and one that is discarded
// without closing can all be dropped, and the next rounds keep working. The
// sanitized lane's audits check that the state and its codec are reclaimed;
// the harness pins the peak RSS of a longer run.

import { gzipSync } from "node:zlib";

const payload = new TextEncoder().encode("payload".repeat(64));
const compressed = gzipSync(Buffer.from(payload));
let rounds = 0;
for (let i = 0; i < 40; i++) {
  const closed = new CompressionStream("gzip");
  const closedWriter = closed.writable.getWriter();
  await closedWriter.write(payload);
  await closedWriter.close();

  const decompressed = new DecompressionStream("gzip");
  const decompressedWriter = decompressed.writable.getWriter();
  const decompressedReader = decompressed.readable.getReader();
  const reading = (async () => {
    let total = 0;
    for (;;) {
      const { value, done } = await decompressedReader.read();
      if (done) break;
      total += value.length;
    }
    return total;
  })();
  await decompressedWriter.write(new Uint8Array(compressed));
  await decompressedWriter.close();
  if ((await reading) !== payload.length) console.log("bad round", i);

  const errored = new DecompressionStream("gzip");
  const erroredWriter = errored.writable.getWriter();
  void erroredWriter.write(new Uint8Array([1, 2, 3, 4])).catch(() => {});

  const cancelled = new DecompressionStream("gzip");
  const cancelledReader = cancelled.readable.getReader();
  await cancelledReader.cancel("done");

  const discarded = new CompressionStream("deflate");
  const discardedWriter = discarded.writable.getWriter();
  void discardedWriter.write(payload).catch(() => {});

  rounds += 1;
  if (i % 10 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
await new Promise<void>((resolve) => setTimeout(resolve, 0));
console.log("lifecycle", rounds);
