// pipeline() whose destination is a function: an async generator
// destination is pumped into the object-mode PassThrough pipeline()
// returns, and an async function destination's resolved value is written
// to it (null and undefined are not). The callback runs with the error
// and the destination's value; a generator yielding null fails the
// pipeline with ERR_STREAM_NULL_VALUES.
import { Readable, pipeline } from "node:stream";

const log = [];

const out = pipeline(
  Readable.from(["a", "b", "c"]),
  async function* (source) {
    for await (const chunk of source) yield { chunk, at: log.length };
  },
  (err, value) => log.push(`gen cb ${err} ${value}`),
);
log.push(`gen out r=${out.readable} w=${out.writable} ro=${out.readableObjectMode} wo=${out.writableObjectMode}`);
for await (const item of out) log.push(`gen read ${JSON.stringify(item)}`);

const summary = pipeline(
  Readable.from([3, 4]),
  async function* (source) {
    for await (const n of source) yield n * n;
  },
  async function (source) {
    let total = 0;
    for await (const n of source) total += n;
    return { total };
  },
  (err, value) => log.push(`fn cb ${err} ${JSON.stringify(value)}`),
);
summary.on("data", (v) => log.push(`fn data ${JSON.stringify(v)}`));
summary.on("end", () => log.push("fn end"));
await new Promise((resolve) => summary.on("close", resolve));

const nothing = pipeline(
  Readable.from(["x"]),
  async function (source) {
    for await (const _ of source);
    return undefined;
  },
  (err) => log.push(`undefined cb ${err}`),
);
nothing.on("data", () => log.push("undefined data"));
nothing.on("end", () => log.push("undefined end"));
await new Promise((resolve) => nothing.on("close", resolve));

const bad = pipeline(
  Readable.from(["g"]),
  async function* (source) {
    for await (const chunk of source) yield chunk;
    yield null;
  },
  (err) => log.push(`null cb ${err && err.code}`),
);
bad.on("data", (c) => log.push(`null data ${c}`));
bad.on("error", (e) => log.push(`null error ${e.code}`));
await new Promise((resolve) => bad.on("close", resolve));

console.log(log.join("\n"));
