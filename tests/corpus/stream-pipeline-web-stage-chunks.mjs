// A web stream stage reads the stage before it as Node's pipeline does: the
// reads come from an async iterator, which combines the chunks that stage has
// buffered, so two writes in the same tick reach the web transform as one
// chunk. An object-mode stage hands over one value per read, and a write in a
// later tick is a read of its own.
import { PassThrough, Readable, Writable, compose } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

const log = [];

/** @param {string[]} into */
function record(into) {
  return new TransformStream({
    transform(chunk, controller) {
      into.push(`${typeof chunk} ${String(chunk)}`);
      controller.enqueue(chunk);
    },
  });
}

/** @param {string[]} into @param {string} tag */
function sinkFor(into, tag) {
  return new Writable({
    objectMode: true,
    write(chunk, _enc, cb) {
      into.push(`${tag} ${typeof chunk} ${String(chunk)}`);
      cb();
    },
  });
}

{
  const seen = [];
  const out = [];
  const head = new PassThrough();
  const done = pipeline(head, record(seen), sinkFor(out, "pipeline"));
  head.write("a");
  head.write("b");
  head.end();
  await done;
  log.push(`pipeline buffered in[${seen.join(" | ")}] out[${out.join(" | ")}]`);
}

{
  const seen = [];
  const out = [];
  const head = new PassThrough({ objectMode: true });
  const done = pipeline(head, record(seen), sinkFor(out, "pipeline"));
  head.write("a");
  head.write("b");
  head.end();
  await done;
  log.push(`pipeline object mode in[${seen.join(" | ")}] out[${out.join(" | ")}]`);
}

{
  const seen = [];
  const out = [];
  const composed = compose(new PassThrough(), record(seen), sinkFor(out, "compose"));
  const done = new Promise((resolve, reject) =>
    composed.on("finish", resolve).on("error", reject),
  );
  composed.write("c");
  composed.write("d");
  composed.end();
  await done;
  log.push(`compose buffered in[${seen.join(" | ")}] out[${out.join(" | ")}]`);
}

{
  const seen = [];
  const out = [];
  const head = new PassThrough();
  const done = pipeline(head, record(seen), sinkFor(out, "pipeline"));
  head.write("e");
  await new Promise((resolve) => setTimeout(resolve, 5));
  head.write("f");
  head.end();
  await done;
  log.push(`pipeline separate ticks in[${seen.join(" | ")}] out[${out.join(" | ")}]`);
}

{
  // an encoded source's strings stay strings at the web stage
  const seen = [];
  const out = [];
  const source = new PassThrough();
  source.setEncoding("utf8");
  const done = pipeline(source, record(seen), sinkFor(out, "encoded"));
  source.write("ab");
  source.end();
  await done;
  log.push(`pipeline encoded in[${seen.join(" | ")}] out[${out.join(" | ")}]`);
}

{
  // a handled upstream failure through a web stage settles the pipeline
  const outcome = await pipeline(
    Readable.from([Buffer.from("not gzip data")]),
    createGunzip(),
    new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk);
      },
    }),
    new Writable({
      write(_chunk, _enc, cb) {
        cb();
      },
    }),
  ).then(
    () => "no error",
    (error) => `rejected ${error.code}`,
  );
  log.push(`pipeline corrupt gzip ${outcome}`);
}

console.log(log.join("\n"));
