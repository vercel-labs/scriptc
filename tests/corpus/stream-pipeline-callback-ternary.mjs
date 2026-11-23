// A completion callback written as a bare expression (`(err) => err ?
// reject(err) : resolve()`), and the bare-expression option callbacks it
// shares its lowering with: the value is discarded, as in a block body, and
// the call settles like Node's.
import { Readable, Transform, Writable, finished, pipeline } from "node:stream";
import { PassThrough } from "node:stream";

const log = [];

await new Promise((resolve, reject) => {
  pipeline(
    Readable.from(["a"]),
    new Writable({
      write(chunk, _enc, cb) {
        cb();
      },
    }),
    (err) => (err ? reject(err) : resolve()),
  );
});
log.push("pipeline ternary");

await new Promise((resolve, reject) => {
  const stream = new PassThrough();
  finished(stream, (err) => err && reject(err));
  stream.on("end", () => setTimeout(resolve, 5));
  stream.end("x");
  stream.resume();
});
log.push("finished logical");

// A pipeline whose middle stage fails reaches the same callback.
await new Promise((resolve) => {
  pipeline(
    Readable.from(["b"]),
    new Writable({
      write(_chunk, _enc, cb) {
        cb(new Error("stop"));
      },
    }),
    (err) => {
      log.push(`pipeline error ${err && err.message}`);
      resolve();
    },
  );
});

const chunks = [];
const readable = new Readable({
  read() {
    this.push(Buffer.from("ab"));
    this.push(null);
  },
});
readable.on("data", (chunk) => chunks.push(chunk.toString()));
await new Promise((resolve) => readable.on("end", resolve));
log.push(`readable data ${chunks.join("")}`);

const transformed = [];
const transform = new Transform({
  transform(chunk, _enc, cb) {
    cb(null, chunk.toString().toUpperCase());
  },
});
transform.on("data", (chunk) => transformed.push(chunk.toString()));
transform.end("hi");
await new Promise((resolve) => transform.on("end", resolve));
log.push(`transform ${transformed.join("")}`);

for (const line of log) console.log(line);
