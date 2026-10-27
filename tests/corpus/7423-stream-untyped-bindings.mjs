// Streams held where the lowering keeps a checked-dynamic value: a
// module-level binding of a stream method's result on a value that a
// JavaScript function returns, an element read of an array of streams,
// and readable.compose on a stream whose function is typed with JSDoc.
import { PassThrough, Readable, Transform } from "node:stream";

const words = () => Readable.from(["alpha", "beta"]);
const shouted = words().map((w) => w.toUpperCase());
console.log("shouted", shouted.readable, shouted.readableObjectMode);
for await (const w of shouted) console.log("shouted", w);

const counted = words().filter((w) => w.length > 4);
counted.on("data", (w) => console.log("counted", w));
await new Promise((resolve) => counted.on("end", resolve));
console.log("counted ended", counted.readableEnded);

const streams = [new PassThrough({ objectMode: true }), new Transform({
  objectMode: true,
  transform(chunk, _enc, cb) {
    cb(null, { wrapped: chunk });
  },
})];
streams[1].end(7);
for await (const v of streams[1]) console.log("element", JSON.stringify(v));
streams[0].end("done");
for await (const v of streams[0]) console.log("element", v);

/** @returns {Readable} */
const typedWords = () => Readable.from(["x", "yy"]);
const lengths = typedWords().compose(async function* (source) {
  for await (const w of source) yield `${w}:${w.length}`;
});
console.log("composed", (await lengths.toArray()).join(","));
