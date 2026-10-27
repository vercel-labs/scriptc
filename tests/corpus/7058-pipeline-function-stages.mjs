// pipeline() function stages from JavaScript: runs of async generator
// stages between streams, stages named by a function declaration and a
// const, sources that are arrays, strings, synchronous generators and
// generator functions (with the ticks Node's async-from-sync iteration
// takes), the string and Buffer methods of generator-fed chunks, and an
// error thrown in a stage after two streams.
import { pipeline, PassThrough, Transform, Writable } from "node:stream";
import { pipeline as pipelinePromise } from "node:stream/promises";
import zlib from "node:zlib";

function sink(into) {
  return new Writable({
    write(chunk, enc, cb) {
      into.push(chunk.toString());
      cb();
    },
  });
}

async function* upper(source) {
  for await (const chunk of source) yield chunk.toString().toUpperCase();
}

const bracket = async function* (source) {
  for await (const chunk of source) yield `[${chunk.trim().replaceAll("\n", "|")}]`;
};

function* letters() {
  yield "a";
  yield "b";
  yield "c";
}

// Stages on both sides of two zlib streams, and a named stage.
{
  const out = [];
  await pipelinePromise(
    async function* () {
      for (let i = 0; i < 3; i++) yield `line ${i}\n`;
    },
    zlib.createGzip(),
    zlib.createGunzip(),
    upper,
    bracket,
    sink(out),
  );
  console.log("split runs:", out.join(""));
}

// Iterable sources, and the destination value that reaches the callback.
await new Promise((resolve) => {
  pipeline(
    ["x", "y", "z"],
    zlib.createDeflate(),
    zlib.createInflate(),
    async function (source) {
      let text = "";
      for await (const chunk of source) text += chunk;
      return text;
    },
    (err, value) => {
      console.log("array source:", err ?? null, value);
      resolve(undefined);
    },
  );
});
{
  const out = [];
  await pipelinePromise("str", upper, sink(out));
  console.log("string source:", out.join(","));
  out.length = 0;
  await pipelinePromise(letters, upper, sink(out));
  console.log("generator function source:", out.join(","));
  out.length = 0;
  await pipelinePromise(letters(), new PassThrough(), sink(out));
  console.log("generator source:", out.join(","));
}

// Generator-fed chunks keep their string and Buffer methods.
{
  const out = [];
  await pipelinePromise(
    async function* () {
      yield Buffer.from("buf");
      yield Buffer.from("fers");
    },
    async function* (source) {
      for await (const chunk of source) yield chunk.toString("hex");
    },
    async function* (source) {
      for await (const chunk of source) yield chunk.padStart(10, "-");
    },
    sink(out),
  );
  console.log("chunk methods:", out.join(" "));
}

// The ticks of iterable sources match Node's for-await over them.
function ticker(log) {
  let on = true;
  (async () => {
    for (let i = 0; on && i < 12; i++) {
      log.push(`t${i}`);
      await null;
    }
  })();
  return () => {
    on = false;
  };
}
{
  const log = [];
  const stop = ticker(log);
  await new Promise((resolve) =>
    pipeline(["a", "b"], new PassThrough(), sink(log), () => {
      stop();
      resolve(undefined);
    }),
  );
  console.log("array ticks:", log.join(" "));
}
{
  const log = [];
  const stop = ticker(log);
  await new Promise((resolve) =>
    pipeline(
      letters,
      async function* (source) {
        for await (const chunk of source) {
          log.push(`stage ${chunk}`);
          yield chunk;
        }
      },
      sink(log),
      () => {
        stop();
        resolve(undefined);
      },
    ),
  );
  console.log("generator function ticks:", log.join(" "));
}

// An error thrown in a stage after two streams destroys both with it.
{
  const log = [];
  const first = new PassThrough();
  const second = new Transform({
    transform(chunk, enc, cb) {
      cb(null, chunk.toString().toUpperCase());
    },
  });
  first.on("close", () => log.push("first close"));
  second.on("close", () => log.push("second close"));
  second.on("error", (e) => log.push(`second error ${e.name}`));
  await new Promise((resolve) => {
    pipeline(
      async function* () {
        yield "one\n";
        yield "two\n";
      },
      first,
      second,
      async function* (source) {
        for await (const chunk of source) {
          log.push(`stage got ${JSON.stringify(chunk)}`);
          if (chunk.length > 100) yield chunk;
          throw new Error("stage failed");
        }
      },
      sink([]),
      (err) => {
        log.push(`callback ${err.message}`);
        setImmediate(resolve);
      },
    );
  });
  console.log(log.join("\n"));
  console.log("destroyed:", first.destroyed, second.destroyed);
}
