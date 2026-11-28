// pipeline() stages that are plain functions: a transform that is not an
// async generator is called while the pipeline is set up with the previous
// stage's stream or async iterable and { signal }, and must return an
// async iterable, or a stream, which the pipeline reads
// (ERR_INVALID_RETURN_VALUE naming the stage otherwise); a plain
// destination's async iterable is pumped into the object-mode PassThrough
// pipeline() answers, and its promise settles the promise form. The stage
// after one that answers its own async iterable receives that iterator
// itself, as Node's makeAsyncIterable passes it. compose() gives its
// middle function stages the same treatment.
import { compose, pipeline, PassThrough, Readable, Writable } from "node:stream";
import { pipeline as pipelineP } from "node:stream/promises";

function sink(into) {
  return new Writable({
    objectMode: true,
    write(chunk, _enc, cb) {
      into.push(String(chunk));
      cb();
    },
  });
}

async function* letters() {
  yield "a";
  yield "b";
}

// an identity plain stage over an async iterable source
const log = [];
await pipelineP(letters(), (source) => source, sink(log));
console.log("identity", log.join(","));

// a plain stage that reads the source and answers a new async iterable
const doubled = [];
await pipelineP(
  letters(),
  (source) =>
    (async function* () {
      for await (const chunk of source) yield chunk + chunk;
    })(),
  sink(doubled),
);
console.log("doubled", doubled.join(","));

// a plain stage between streams, with the options argument
const seen = [];
const out = [];
await pipelineP(
  letters(),
  new PassThrough({ objectMode: true }),
  (source, options) => {
    seen.push(typeof options.signal.aborted);
    return (async function* () {
      for await (const chunk of source) yield `${chunk}!`;
    })();
  },
  sink(out),
);
console.log("between streams", seen.join(","), out.join(","));

// the iterator a plain stage answers reaches the next plain stage itself
const mine = (async function* () {
  yield "m1";
  yield "m2";
})();
const handed = [];
await pipelineP(
  letters(),
  () => mine,
  (source) => {
    handed.push(Object.is(source, mine));
    return source;
  },
  sink([]),
);
console.log("handoff", handed.join(","));

// a plain stage after an async generator stage receives its generator
{
  const out = [];
  await pipelineP(
    letters(),
    async function* (source) {
      for await (const chunk of source) yield chunk.toUpperCase();
    },
    (source) => source,
    sink(out),
  );
  console.log("after generator", out.join(","));
}

// a stream a plain stage answers is read as an async iterable, as Node's
// makeAsyncIterable passes a readable on
{
  const out = [];
  await pipelineP(Readable.from(["r1", "r2"]), (source) => source, sink(out));
  console.log("stream identity", out.join(","));
}
{
  const out = [];
  await pipelineP(
    Readable.from(["s1"]),
    () => Readable.from(["n1", "n2"]),
    sink(out),
  );
  console.log("stream result", out.join(","));
}

// a web stream a plain stage answers is read as an async iterable too
{
  const out = [];
  await pipelineP(
    letters(),
    () =>
      Readable.toWeb(
        Readable.from(["w1", "w2"], {
          objectMode: true,
        }),
      ),
    sink(out),
  );
  console.log("web stream result", out.join(","));
}

// a destination plain stage: its iterable feeds the PassThrough the
// callback form answers, and the callback's value is undefined
let destCallback;
const dest = pipeline(letters(), (source) => source, (err, value) => {
  destCallback = `${err} ${value}`;
});
const chunks = [];
for await (const chunk of dest) chunks.push(String(chunk));
console.log("destination", dest.readableObjectMode, chunks.join(","));
await new Promise((resolve) => setImmediate(resolve));
console.log("destination callback", destCallback);

// a destination that answers the stream it was given
{
  let streamCallback;
  const destStream = pipeline(
    Readable.from(["t1", "t2"]),
    (source) => source,
    (err, value) => {
      streamCallback = `${err} ${value}`;
    },
  );
  const read = [];
  for await (const chunk of destStream) read.push(String(chunk));
  console.log("stream destination", destStream.readableObjectMode, read.join(","));
  await new Promise((resolve) => setImmediate(resolve));
  console.log("stream destination callback", streamCallback);
}

// a destination async function's value settles the promise form
console.log(
  "destination value",
  await pipelineP(letters(), async (source) => {
    let text = "";
    for await (const chunk of source) text += chunk;
    return text.split("").reverse().join("");
  }),
);

// a plain destination that answers a promise settles the promise form too
console.log(
  "plain promise destination",
  await pipelineP(letters(), (source) => {
    let text = "";
    return (async () => {
      for await (const chunk of source) text += chunk;
      return text.length;
    })();
  }),
);

// a plain stage that throws fails the pipeline
try {
  await pipelineP(
    letters(),
    (source) =>
      (async function* () {
        for await (const chunk of source) {
          if (chunk === "b") throw new Error("plain stage failed");
          yield chunk;
        }
      })(),
    sink([]),
  );
} catch (err) {
  console.log("throwing stage", err.message);
}

// compose() gives its middle plain stages the same treatment
{
  const out = [];
  const composed = compose(
    Readable.from(["c1", "c2"]),
    (source) => source,
    async function* (source) {
      for await (const chunk of source) yield `${chunk}!`;
    },
    new PassThrough({ objectMode: true }),
  );
  for await (const chunk of composed) out.push(String(chunk));
  console.log("compose", out.join(","));
}
try {
  compose(
    Readable.from(["c"]),
    () => 42,
    new PassThrough({ objectMode: true }),
  );
} catch (err) {
  console.log("compose error", err.code, err.message);
}

// a plain stage after an untyped source gets the source itself: an
// untyped array source answered back is Node's array error, and a source
// function's iterable reaches the stage as it was returned
function pick(v) {
  return v;
}
try {
  await pipelineP(pick(["u"]), (source) => source, sink([]));
} catch (err) {
  console.log("untyped source", err.code, err.message);
}
{
  const fromFn = (async function* () {
    yield "z1";
    yield "z2";
  })();
  const seen = [];
  await pipelineP(
    pick(() => fromFn),
    (source) => {
      seen.push(Object.is(source, fromFn));
      return source;
    },
    sink([]),
  );
  console.log("untyped source function", seen.join(","));
}

// results that are not async iterables throw ERR_INVALID_RETURN_VALUE
// naming the stage
try {
  await pipelineP(letters(), () => 42, sink([]));
} catch (err) {
  console.log("number", err.code, err.message);
}
try {
  await pipelineP(letters(), () => "wrong", sink([]));
} catch (err) {
  console.log("string", err.code, err.message);
}
try {
  await pipelineP(letters(), () => null, sink([]));
} catch (err) {
  console.log("null", err.code, err.message);
}
try {
  await pipelineP(letters(), () => undefined, sink([]));
} catch (err) {
  console.log("undefined", err.code, err.message);
}
try {
  await pipelineP(letters(), () => ["sync"], sink([]));
} catch (err) {
  console.log("array", err.code, err.message);
}
try {
  await pipelineP(letters(), () => ({}), sink([]));
} catch (err) {
  console.log("object", err.code, err.message);
}
try {
  await pipelineP(
    letters(),
    function* () {
      yield "sync";
    },
    sink([]),
  );
} catch (err) {
  console.log("generator", err.code, err.message);
}
try {
  await pipelineP(letters(), async () => "later", sink([]));
} catch (err) {
  console.log("promise", err.code, err.message);
}

// a destination's result is classified at run time too
try {
  pipeline(letters(), () => 7, () => console.log("destination error callback"));
} catch (err) {
  console.log("destination error", err.code, err.message);
}
