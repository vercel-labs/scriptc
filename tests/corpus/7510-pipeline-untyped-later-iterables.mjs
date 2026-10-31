// pipeline() with an untyped stage after the first that is not a stream or
// a function: Node takes Duplex.from of it, so an iterable becomes the
// readable stage the next stream is piped from, the stages before it are
// not read and are destroyed when the pipeline finishes, and a value
// Duplex.from rejects throws ERR_INVALID_ARG_TYPE.
import { pipeline, Writable, Readable, Duplex } from "node:stream";
import { pipeline as pipelineP } from "node:stream/promises";

function pick(v) {
  return v;
}
function sink(label) {
  return new Writable({
    objectMode: true,
    write(chunk, _enc, cb) {
      console.log(label, "write", JSON.stringify(String(chunk)));
      cb();
    },
  });
}
function watched(label, values) {
  const source = Readable.from(values);
  source.on("error", (err) => console.log(label, "error", err.code));
  source.on("close", () => console.log(label, "close", source.destroyed));
  return source;
}

await pipelineP(watched("first", ["unread"]), pick(["z1", "z2"]), sink("array"));
console.log("array resolved");
await new Promise((r) => setTimeout(r, 5));

await new Promise((resolve) => {
  pipeline(watched("second", ["unread"]), pick("text"), sink("string"), (err) => {
    console.log("string done", err);
    resolve(undefined);
  });
});
await new Promise((r) => setTimeout(r, 5));

// a generator stage before the iterable is never read
await pipelineP(
  Readable.from(["s"]),
  pick(async function* (source) {
    console.log("generator stage called");
    for await (const chunk of source) yield chunk;
  }),
  pick(new Set(["set1", "set2"])),
  sink("set"),
);
console.log("set resolved");

// the iterable as the last stage is what pipeline() returns
const last = pipeline(Readable.from(["u"]), pick(["tail"]), () => console.log("never"));
console.log(last instanceof Duplex, last.readable, last.writable);
for await (const chunk of last) console.log("last", chunk);

for (const value of [42, { plain: true }, null]) {
  try {
    await pipelineP(Readable.from(["i"]), pick(value), sink("rejected"));
  } catch (err) {
    console.log(err.name, err.code, err.message);
  }
}
console.log("done");
