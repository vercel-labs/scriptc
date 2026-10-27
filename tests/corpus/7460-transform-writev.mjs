// writev on a Transform and a PassThrough (the writev option): a batch of
// buffered writes reaches writev instead of the transform, a lone write
// still reaches the transform, and the readable side gets what writev
// pushes.
import { Transform, PassThrough } from "node:stream";
const t = new Transform({
  transform(chunk, enc, cb) { console.log("transform", String(chunk), enc); cb(null, chunk); },
  writev(chunks, cb) {
    console.log("writev", chunks.map((c) => `${c.chunk}/${c.encoding}`).join(","));
    for (const { chunk } of chunks) this.push(String(chunk).toUpperCase());
    cb();
  },
});
t.on("data", (d) => console.log("data", String(d)));
t.on("finish", () => console.log("finish"));
t.on("end", () => console.log("end"));
t.write("a");
t.cork();
t.write("b");
t.write("c", "latin1");
process.nextTick(() => { t.uncork(); t.end("d"); });

const p = new PassThrough({
  objectMode: true,
  writev(chunks, cb) { console.log("pt writev", JSON.stringify(chunks.map((c) => c.chunk))); cb(); },
});
p.on("data", (d) => console.log("pt data", JSON.stringify(d)));
p.cork();
p.write({ x: 1 });
p.write([2]);
p.uncork();
p.write("solo");
p.end();
