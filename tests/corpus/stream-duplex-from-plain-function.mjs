// Duplex.from over a plain function body: the function is called with the
// write source and { signal } while the duplex is built, and the value it
// answers — a synchronous or asynchronous iterable, or a readable stream —
// is read as the readable side; anything else is the "body" form of
// ERR_INVALID_RETURN_VALUE. compose()'s function head is Duplex.from of it.
import { Duplex, PassThrough, Readable, Writable, compose } from "node:stream";

const collect = async (stream) => {
  const out = [];
  for await (const chunk of stream) out.push(String(chunk));
  return out.join(",");
};

// an array-returning body
{
  const duplex = Duplex.from(() => ["a", "b"]);
  console.log("array", duplex.writable, duplex.readable, duplex.readableObjectMode, await collect(duplex));
}

// an async generator body
{
  const duplex = Duplex.from(
    () =>
      (async function* () {
        yield "g1";
        yield "g2";
      })(),
  );
  console.log("generator", await collect(duplex));
}

// a synchronous generator function body
{
  const duplex = Duplex.from(function* () {
    yield "s1";
  });
  console.log("sync generator", await collect(duplex));
}

// a readable stream body
{
  const duplex = Duplex.from(() => Readable.from(["r1"]));
  console.log("readable", await collect(duplex));
}

// the options argument
{
  const duplex = Duplex.from((_source, options) => {
    console.log("options", typeof options.signal.aborted);
    return ["o1"];
  });
  console.log("options chunks", await collect(duplex));
}

// writes reach the source the body received when it reads it
{
  const duplex = Duplex.from(
    (source) =>
      (async function* () {
        for await (const chunk of source) yield `seen ${chunk}`;
      })(),
  );
  const out = [];
  duplex.on("data", (chunk) => out.push(String(chunk)));
  duplex.write("w1");
  duplex.end();
  await new Promise((resolve) => duplex.on("end", resolve));
  console.log("write source", out.join(","));
}

// results that are not iterable throw the "body" form of the error
try {
  Duplex.from(() => 42);
} catch (err) {
  console.log("number", err.code, err.message);
}
try {
  Duplex.from(() => null);
} catch (err) {
  console.log("null", err.code, err.message);
}
try {
  Duplex.from(() => undefined);
} catch (err) {
  console.log("undefined", err.code, err.message);
}
try {
  Duplex.from(
    () =>
      new Writable({
        write(_chunk, _enc, cb) {
          cb();
        },
      }),
  );
} catch (err) {
  console.log("writable", err.code, err.message);
}

// compose()'s function head is Duplex.from of the function
{
  const composed = compose(
    () => ["c1", "c2"],
    async function* (source) {
      for await (const chunk of source) yield String(chunk).toUpperCase();
    },
    new PassThrough({ objectMode: true }),
  );
  console.log("compose", await collect(composed));
}
