// Many BYOB reads queued at once over a chunk larger than their views: the
// adapter serves them from the chunk's remainder, and each answered read must
// not pull again in its own stack (that recursed once per queued read and
// overflowed the native stack). The chunk is 64 KiB, the views one byte, and
// more reads than bytes are queued so the tail reads also finish at EOF.
import { Readable } from "node:stream";

const source = new Readable({
  read() {
    this.push(Buffer.alloc(64 * 1024, 65));
    this.push(null);
  },
});
const web = Readable.toWeb(source, { type: "bytes" });
const reader = web.getReader({ mode: "byob" });
const reads: Promise<{ done?: boolean; value?: Uint8Array | null }>[] = [];
for (let i = 0; i < 70_000; i++) reads.push(reader.read(new Uint8Array(1)));
const results = await Promise.all(reads);
let bytes = 0;
let done = 0;
for (const result of results) {
  if (result.value) bytes += result.value.byteLength;
  if (result.done) done++;
}
console.log("bytes", bytes, "done", done);
