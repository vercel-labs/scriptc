// pipeline() with untyped stages after the first that are functions: a
// transform is called with the previous stream or generator and
// { signal } while the pipeline is set up, and must return an async
// iterable; an async function destination's value resolves the promise
// form and reaches the callback; an async generator destination feeds
// the PassThrough that pipeline() returns. Results of the wrong kind throw
// ERR_INVALID_RETURN_VALUE naming the stage. A stage after an untyped
// source function or transform receives that stage's own iterator, as
// Node's makeAsyncIterable answers an iterable itself.
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
  });
}
const upper = pick(async function* (source, { signal }) {
  console.log("upper called", source instanceof Readable, typeof signal.aborted);
  for await (const chunk of source) yield String(chunk).toUpperCase();
});
const join = pick(async (source) => {
  let text = "";
  for await (const chunk of source) text += chunk;
  return text;
});

await pipelineP(Readable.from(["a", "b"]), upper, sink("transform"));
console.log("joined", await pipelineP(Readable.from(["x", "y"]), upper, join));
console.log("two transforms", await pipelineP(pick(["m", "n"]), upper, upper, join));

await new Promise((resolve) => {
  pipeline(Readable.from(["c1", "c2"]), upper, join, (err, value) => {
    console.log("callback", err, value);
    resolve(undefined);
  });
});

// an async generator destination
const wrap = pick(async function* (source) {
  for await (const chunk of source) yield `<${chunk}>`;
});
const out = pipeline(Readable.from(["p1", "p2"]), wrap, (err, value) => {
  console.log("generator destination done", err, value);
});
console.log("returns a PassThrough", out instanceof PassThrough);
for await (const chunk of out) console.log("passthrough", chunk);

// an async generator destination in the promise form: the PassThrough
// takes its values and the promise resolves to undefined
const promised = await pipelineP(Readable.from(["q1", "q2"]), wrap);
console.log("generator destination promise", promised, typeof promised);

// a destination whose promise rejects
try {
  await pipelineP(
    Readable.from(["r"]),
    pick(async (source) => {
      for await (const chunk of source) console.log("rejecting after", chunk);
      throw new Error("destination failed");
    }),
  );
} catch (err) {
  console.log("rejected", err.message);
}

// results of the wrong kind
try {
  await pipelineP(Readable.from(["i"]), pick(() => 5), sink("number"));
} catch (err) {
  console.log("transform result", err.name, err.code, err.message);
}
try {
  await pipelineP(Readable.from(["i"]), upper, pick(() => ["sync"]), sink("array"));
} catch (err) {
  console.log("second transform result", err.code, err.message);
}
try {
  pipeline(Readable.from(["i"]), pick(() => 7), () => console.log("never"));
} catch (err) {
  console.log("destination result", err.name, err.code, err.message);
}
// the iterators handed from stage to stage
let transformIter = null;
const handed = await pipelineP(
  pick(function* () {
    yield "s1";
    yield "s2";
  }),
  pick((source) => {
    // a sync generator, not an async iterator over it
    console.log(
      "transform gets the source's iterator",
      typeof source[Symbol.asyncIterator],
      typeof source[Symbol.iterator],
    );
    transformIter = (async function* () {
      for await (const chunk of source) yield `${chunk}!`;
    })();
    return transformIter;
  }),
  pick(async (source) => {
    console.log("destination gets the transform's iterator", source === transformIter);
    let text = "";
    for await (const chunk of source) text += chunk;
    return text;
  }),
);
console.log("handed", handed);
console.log("done");
