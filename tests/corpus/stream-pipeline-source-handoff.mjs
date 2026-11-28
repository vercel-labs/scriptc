// A plain stage after a statically typed iterable source receives the
// source value itself — as Node's makeAsyncIterable passes an iterable on —
// not the pipeline's internal generator: the stage can read its members,
// and answering it back throws ERR_INVALID_RETURN_VALUE for a value that is
// not async iterable.
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

function sink(into) {
  return new Writable({
    objectMode: true,
    write(chunk, _enc, cb) {
      into.push(String(chunk));
      cb();
    },
  });
}

// an array source: the stage reads the array's members
{
  const items = ["a", "b"];
  const seen = [];
  const out = [];
  await pipeline(
    items,
    (source) => {
      seen.push(Array.isArray(source), source.length, String(source));
      return (async function* () {
        for (const item of source) yield item;
      })();
    },
    sink(out),
  );
  console.log("array", seen.join(","), out.join(","));
}

// answering the array back is not an async iterable
try {
  await pipeline(["a", "b"], (source) => source, sink([]));
} catch (err) {
  console.log("array return", err.code, err.message);
}

// a string source
{
  const text = "xy";
  const seen = [];
  const out = [];
  await pipeline(
    text,
    (source) => {
      seen.push(typeof source, source.length, String(source));
      return (async function* () {
        for (const chunk of source) yield chunk;
      })();
    },
    sink(out),
  );
  console.log("string", seen.join(","), out.join(","));
}
try {
  await pipeline("xy", (source) => source, sink([]));
} catch (err) {
  console.log("string return", err.code, err.message);
}

// a synchronous generator object source
{
  function* letters() {
    yield "g1";
    yield "g2";
  }
  const source = letters();
  const out = [];
  await pipeline(
    source,
    (gen) =>
      (async function* () {
        for await (const item of gen) yield item;
      })(),
    sink(out),
  );
  console.log("generator", out.join(","));
}
try {
  function* letters() {
    yield "g1";
  }
  await pipeline(letters(), (gen) => gen, sink([]));
} catch (err) {
  console.log("generator return", err.code, err.message);
}

// a web stream source
{
  const seen = [];
  const out = [];
  await pipeline(
    Readable.toWeb(Readable.from(["w1", "w2"])),
    (source) => {
      seen.push(typeof source, typeof source.getReader);
      return (async function* () {
        for await (const chunk of source) yield chunk;
      })();
    },
    sink(out),
  );
  console.log("web stream", seen.join(","), out.join(","));
}
