// A web stream as a compose stage before the last: Node hands the stage to
// the pipeline, which keeps its chunks web values, so the value a transform
// enqueues reaches the next node stream as the value it is — a string stays
// a string, a number a number, an object an object. The composed Duplex's
// own readable side is byte mode, so a web stream in the last position hands
// the chunks it reads on as Buffers.
import { PassThrough, Transform, Writable, compose } from "node:stream";

const log = [];

/** @param {string} tag @param {string[]} into */
function sinkFor(tag, into) {
  return new Writable({
    objectMode: true,
    write(chunk, _enc, cb) {
      const shown =
        chunk !== null && typeof chunk === "object" ? JSON.stringify(chunk) : String(chunk);
      into.push(`${tag} ${chunk === null ? "null" : typeof chunk} ${shown}`);
      cb();
    },
  });
}

/** @param {string} suffix */
const upper = (suffix) =>
  new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(String(chunk).toUpperCase() + suffix);
    },
  });

/** @param {string} tag @param {import("node:stream").Duplex} composed @param {import("node:stream").Writable} sink @param {...any} chunks */
async function run(tag, composed, sink, ...chunks) {
  const composedDone = new Promise((resolve, reject) =>
    composed.on("finish", resolve).on("error", reject),
  );
  const sinkDone = new Promise((resolve, reject) => sink.on("finish", resolve).on("error", reject));
  for (const chunk of chunks) composed.write(chunk);
  composed.end();
  await composedDone;
  await sinkDone;
  log.push(`${tag} r=${composed.readable} w=${composed.writable}`);
}

{
  const out = [];
  const sink = sinkFor("head", out);
  const composed = compose(upper("!"), sink);
  await run(`head web transform wm=${composed.writableObjectMode}`, composed, sink, "a");
  log.push(out.join(" | "));
}

{
  const out = [];
  const sink = sinkFor("pair", out);
  const transform = upper("?");
  const composed = compose({ readable: transform.readable, writable: transform.writable }, sink);
  await run("head web pair", composed, sink, "b");
  log.push(out.join(" | "));
}

{
  const out = [];
  const sink = sinkFor("middle", out);
  const composed = compose(new PassThrough(), upper("&"), sink);
  await run("middle web transform", composed, sink, "c");
  log.push(out.join(" | "));
}

{
  const out = [];
  const sink = sinkFor("pair", out);
  const transform = upper("%");
  const composed = compose(
    new PassThrough(),
    { readable: transform.readable, writable: transform.writable },
    sink,
  );
  await run("middle web pair", composed, sink, "d");
  log.push(out.join(" | "));
}

{
  const out = [];
  const sink = sinkFor("number", out);
  const doubler = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(Number(chunk) * 2);
    },
  });
  const composed = compose(new PassThrough({ objectMode: true }), doubler, sink);
  await run("middle web number", composed, sink, 21);
  log.push(out.join(" | "));
}

{
  const out = [];
  const sink = sinkFor("object", out);
  const wrapper = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue({ v: chunk });
      controller.enqueue({ v: `${chunk}-again` });
    },
  });
  const composed = compose(new PassThrough({ objectMode: true }), wrapper, sink);
  await run("middle web object", composed, sink, "e");
  log.push(out.join(" | "));
}

{
  const out = [];
  const sink = sinkFor("alpha", out);
  const composed = compose(new PassThrough(), upper("1"), upper("2"), sink);
  await run("two web stages", composed, sink, "f");
  log.push(out.join(" | "));
}

{
  const out = [];
  const sink = sinkFor("node-web", out);
  const composed = compose(
    new PassThrough(),
    new Transform({
      transform(chunk, _enc, cb) {
        cb(null, String(chunk).toUpperCase());
      },
    }),
    upper("+"),
    sink,
  );
  await run("node then web", composed, sink, "g");
  log.push(out.join(" | "));
}

{
  const out = [];
  const sink = sinkFor("staged-mid", out);
  const composed = compose(
    new PassThrough(),
    upper("%"),
    async function* (source) {
      for await (const chunk of source) yield chunk;
    },
    sink,
  );
  await run("staged middle", composed, sink, "j");
  log.push(out.join(" | "));
}

{
  // a compose with a function stage reads a web last stage in byte mode too
  const composed = compose(
    new PassThrough(),
    async function* (source) {
      for await (const chunk of source) yield String(chunk);
    },
    upper("="),
  );
  const data = [];
  composed.on("data", (chunk) =>
    data.push(`${Buffer.isBuffer(chunk) ? "buf" : typeof chunk} ${String(chunk)}`),
  );
  const ended = new Promise((resolve) => composed.on("end", resolve));
  composed.write("i");
  composed.end();
  await ended;
  log.push(`staged tail data=${data.join(" | ")} rom=${composed.readableObjectMode}`);
}

{
  const composed = compose(new PassThrough(), upper("-"));
  const data = [];
  composed.on("data", (chunk) =>
    data.push(`${Buffer.isBuffer(chunk) ? "buf" : typeof chunk} ${String(chunk)}`),
  );
  composed.end("h");
  await new Promise((resolve) => composed.on("end", resolve));
  log.push(`tail web data=${data.join(" | ")} rom=${composed.readableObjectMode}`);
}

{
  // an object-mode stage before a web last stage hands it the value it wrote
  const seen = [];
  const composed = compose(
    new PassThrough({ objectMode: true }),
    new TransformStream({
      transform(chunk, controller) {
        seen.push(`${typeof chunk} ${String(chunk)}`);
        controller.enqueue(chunk);
      },
    }),
  );
  const data = [];
  composed.on("data", (chunk) =>
    data.push(`${Buffer.isBuffer(chunk) ? "buf" : typeof chunk} ${String(chunk)}`),
  );
  const ended = new Promise((resolve) => composed.on("end", resolve));
  composed.write("s");
  composed.end();
  await ended;
  log.push(`tail object-mode in[${seen.join(" | ")}] data[${data.join(" | ")}]`);
}

console.log(log.join("\n"));
