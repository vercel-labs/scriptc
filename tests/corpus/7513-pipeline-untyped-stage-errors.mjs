// Untyped pipeline function stages next to typed stages: an untyped stage
// after a typed generator stage or a Transform, the { signal } an untyped
// stage receives aborting when the pipeline fails, and an untyped stage
// that throws while the pipeline is set up.
import { pipeline, Writable, Readable, Transform } from "node:stream";
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

await pipelineP(
  Readable.from(["a", "b"]),
  async function* (source) {
    for await (const chunk of source) yield `${chunk}1`;
  },
  pick(async function* (source) {
    for await (const chunk of source) yield `${chunk}2`;
  }),
  sink("after generator"),
);

await pipelineP(
  Readable.from(["q"]),
  new Transform({
    transform(chunk, _enc, cb) {
      cb(null, chunk);
    },
  }),
  pick(async (source) => {
    for await (const chunk of source) console.log("destination saw", String(chunk));
  }),
);

let seen;
try {
  await pipelineP(
    Readable.from(["x", "y"]),
    pick(async function* (source, { signal }) {
      seen = signal;
      signal.addEventListener("abort", () => console.log("signal abort event"));
      for await (const chunk of source) yield chunk;
    }),
    new Writable({
      write(_chunk, _enc, cb) {
        cb(new Error("write failed"));
      },
    }),
  );
} catch (err) {
  console.log("rejected", err.message, seen.aborted);
}

try {
  pipeline(
    Readable.from(["t"]),
    pick(() => {
      throw new Error("stage threw");
    }),
    sink("never"),
    () => console.log("never called"),
  );
} catch (err) {
  console.log("callback form threw", err.message);
}
try {
  await pipelineP(
    Readable.from(["t"]),
    pick(() => {
      throw new Error("stage threw again");
    }),
    sink("never"),
  );
} catch (err) {
  console.log("promise form rejected", err.message);
}
console.log("done");
