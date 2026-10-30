// pipeline() over untyped first stages that are functions or
// { readable, writable } pairs: a source function is called with
// { signal } while the pipeline is set up and its iterable result is
// pumped; a result that is not iterable throws ERR_INVALID_RETURN_VALUE
// from the callback form and rejects the promise form; a pair pumps its
// readable side.
import { pipeline, Writable, Readable, PassThrough } from "node:stream";
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
    final(cb) {
      console.log(label, "final");
      cb();
    },
  });
}

const arraySource = pick(function (opts) {
  console.log("array source called", typeof opts, typeof opts.signal, opts.signal.aborted);
  return ["a1", "a2"];
});
const before = pipelineP(arraySource, sink("array"));
console.log("after pipeline() returned");
await before;
console.log("array resolved");

await pipelineP(pick(() => "xy"), sink("string"));

await pipelineP(
  pick(async function* ({ signal }) {
    console.log("generator source", typeof signal.aborted);
    yield "g1";
    await new Promise((r) => setTimeout(r, 1));
    yield "g2";
  }),
  pick(async function* (source) {
    for await (const chunk of source) yield `[${chunk}]`;
  }),
  sink("generator"),
);

await new Promise((resolve) => {
  pipeline(pick(() => new Set(["s1", "s2"])), sink("set"), (err) => {
    console.log("set done", err);
    resolve(undefined);
  });
});

// a result that is not iterable
try {
  pipeline(pick(() => 5), sink("five"), () => console.log("five callback"));
} catch (err) {
  console.log("five threw", err.name, err.code, err.message);
}
try {
  await pipelineP(pick(() => ({ value: 1 })), sink("object"));
} catch (err) {
  console.log("object rejected", err.name, err.code, err.message);
}

// a source function that throws
try {
  await pipelineP(
    pick(() => {
      throw new Error("source failed");
    }),
    sink("throws"),
  );
} catch (err) {
  console.log("throws rejected", err.message);
}

// a { readable, writable } pair pumps its readable side
const side = new PassThrough();
await pipelineP(pick({ readable: Readable.from(["p1", "p2"]), writable: side }), sink("pair"));
console.log("done");
