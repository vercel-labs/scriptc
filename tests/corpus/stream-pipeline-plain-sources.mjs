// pipeline() plain function sources: Node's source branch calls the
// function with { signal } while the pipeline is set up and requires an
// iterable (synchronous or asynchronous) or a stream, which is read as an
// async iterable; any other result throws ERR_INVALID_RETURN_VALUE naming
// the source. The returned iterable reaches the next plain stage itself.
import { Readable, Writable, pipeline } from "node:stream";
import { pipeline as pipelinePromise } from "node:stream/promises";

function sink(into) {
  return new Writable({
    objectMode: true,
    write(chunk, _enc, cb) {
      into.push(String(chunk));
      cb();
    },
  });
}

const wrap = (source) =>
  (async function* () {
    for await (const chunk of source) yield chunk;
  })();

// a synchronous iterable source
{
  const out = [];
  await pipelinePromise(() => ["a", "b"], wrap, sink(out));
  console.log("array source", out.join(","));
}

// an async generator source
{
  const out = [];
  await pipelinePromise(
    () =>
      (async function* () {
        yield "g1";
        yield "g2";
      })(),
    (source) => source,
    sink(out),
  );
  console.log("generator source", out.join(","));
}

// a readable stream source
{
  const out = [];
  await pipelinePromise(() => Readable.from(["r1", "r2"]), (source) => source, sink(out));
  console.log("stream source", out.join(","));
}

// a web stream source
{
  const out = [];
  await pipelinePromise(() => Readable.toWeb(Readable.from(["w1", "w2"])), wrap, sink(out));
  console.log("web stream source", out.join(","));
}

// the options argument
{
  const seen = [];
  const out = [];
  await pipelinePromise(
    (options) => {
      seen.push(typeof options.signal.aborted);
      return ["o1"];
    },
    wrap,
    sink(out),
  );
  console.log("options", seen.join(","), out.join(","));
}

// the returned iterable is handed to the next plain stage itself
{
  const items = ["h1"];
  const seen = [];
  await pipelinePromise(
    () => items,
    (source) => {
      seen.push(Object.is(source, items));
      return wrap(source);
    },
    sink([]),
  );
  console.log("handoff", seen.join(","));
}

// a string source
{
  const out = [];
  await pipelinePromise(() => "xy", wrap, sink(out));
  console.log("string source", out.join(","));
}

// results that are not iterable throw ERR_INVALID_RETURN_VALUE naming the
// source
try {
  await pipelinePromise(() => 42, wrap, sink([]));
} catch (err) {
  console.log("number", err.code, err.message);
}
try {
  await pipelinePromise(async () => 1, wrap, sink([]));
} catch (err) {
  console.log("promise", err.code, err.message);
}
try {
  await pipelinePromise(
    () =>
      new Writable({
        write(_chunk, _enc, cb) {
          cb();
        },
      }),
    wrap,
    sink([]),
  );
} catch (err) {
  console.log("writable", err.code, err.message);
}

// a synchronous generator function source keeps its lowering
{
  const out = [];
  await pipelinePromise(
    function* () {
      yield "s1";
    },
    wrap,
    sink(out),
  );
  console.log("sync generator source", out.join(","));
}

// an error thrown by the source function fails the pipeline
try {
  await pipelinePromise(
    () => {
      throw new Error("source failed");
    },
    wrap,
    sink([]),
  );
} catch (err) {
  console.log("throwing source", err.message);
}
