// A web stage under backpressure delivers every record it was fed before the
// pipeline ends: the destination ends when the stage's buffered values have
// reached it, not when the source stops producing them.
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

const seen = [];
const out = [];
const stage = new TransformStream({
  async transform(chunk, controller) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    seen.push(chunk);
    controller.enqueue(chunk);
  },
});
const sink = new Writable({
  objectMode: true,
  highWaterMark: 1,
  write(chunk, _enc, cb) {
    out.push(chunk);
    setTimeout(cb, 2);
  },
});
const values = Array.from({ length: 40 }, (_, k) => k);
await pipeline(Readable.from(values, { objectMode: true }), stage, sink);
console.log(`stage ${seen.length} out ${out.length} last ${out[out.length - 1]}`);
