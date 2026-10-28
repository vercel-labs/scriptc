// Web WritableStream from untyped JavaScript: the classes as constructor
// values, prototypes and brand checks, writers with backpressure and their
// ready and closed promises, queuing strategies, sink errors, close and
// abort ordering, the controller's signal, and argument errors, in Node's
// promise order.
import { WritableStream as WebWritableStream, WritableStreamDefaultWriter, WritableStreamDefaultController } from "node:stream/web";

const log = [];
const out = (...args) => log.push(args.map(String).join(" "));
const caught = (fn) => {
  try {
    fn();
    return "ok";
  } catch (e) {
    return `${e.name}:${e.code ?? ""}:${e.message}`;
  }
};
const settled = (p) => p.then((v) => `ok:${v}`, (e) => `${e?.name}:${e?.code ?? ""}:${e?.message ?? e}`);

out("classes", typeof WritableStream, WritableStream === WebWritableStream, WritableStream.name, WritableStream.length, WritableStreamDefaultWriter.length);
out("illegal", caught(() => new WritableStreamDefaultController()), caught(() => /** @type {any} */ (WritableStream)()));
out("prototype", Object.keys(WritableStream.prototype).join(","), Object.keys(WritableStreamDefaultWriter.prototype).join(","), Object.keys(WritableStreamDefaultController.prototype).join(","));

{
  const order = [];
  const chunks = [];
  const stream = new WritableStream(
    {
      start() { order.push("start"); },
      write(chunk, controller) {
        order.push(`write ${chunk}`);
        chunks.push(chunk);
        return new Promise((resolve) => setTimeout(resolve, 1));
      },
      close() { order.push("close"); },
    },
    new CountQueuingStrategy({ highWaterMark: 2 }),
  );
  const writer = stream.getWriter();
  out("writer", writer instanceof WritableStreamDefaultWriter, stream.locked, writer.desiredSize, caught(() => stream.getWriter()));
  const writes = [writer.write("a"), writer.write("b"), writer.write("c")];
  out("queued", writer.desiredSize, Object.prototype.toString.call(stream), Object.prototype.toString.call(writer));
  let readySettled = false;
  writer.ready.then(() => { readySettled = true; });
  await Promise.resolve();
  out("backpressure", readySettled, order.join(" | "));
  for (const w of writes) await w;
  await writer.ready;
  out("drained", writer.desiredSize, readySettled, chunks.join(""));
  await writer.close();
  out("closed", await settled(writer.closed), writer.desiredSize, order.join(" | "), await settled(writer.write("late")));
  writer.releaseLock();
  out("released", stream.locked, await settled(writer.closed), caught(() => writer.desiredSize));
}

{
  const sizes = [];
  const stream = new WritableStream(
    { write() {} },
    { highWaterMark: 10, size(chunk) { sizes.push(chunk.length); return chunk.length; } },
  );
  const writer = stream.getWriter();
  const good = writer.write("abcd");
  out("sizes", writer.desiredSize, sizes.join(","));
  const bad = writer.write({ length: -1 });
  out("bad-size", await settled(good), await settled(bad), await settled(writer.closed), writer.desiredSize);
}

{
  const failure = new Error("sink-write");
  const stream = new WritableStream({ write() { throw failure; } });
  const writer = stream.getWriter();
  const first = writer.write("x");
  const second = writer.write("y");
  out("write-error", await settled(first), await settled(second), await settled(writer.closed), await settled(writer.ready));
}

{
  const log2 = [];
  /** @type {any} */
  let controller;
  const reason = new Error("stop");
  const stream = new WritableStream({
    start(c) {
      controller = c;
      c.signal.addEventListener("abort", () => log2.push(`signal ${c.signal.reason === reason}`));
    },
    write(chunk) { log2.push(`write ${chunk}`); },
    abort(e) { log2.push(`abort ${e === reason}`); },
  });
  const writer = stream.getWriter();
  await writer.write("one");
  const abort = writer.abort(reason);
  log2.push("aborting");
  out("abort", await settled(abort), log2.join(" | "), controller.signal.aborted, await settled(writer.closed), writer.desiredSize);
}

{
  /** @type {any} */
  let controller;
  const stream = new WritableStream({ start(c) { controller = c; } });
  const writer = stream.getWriter();
  controller.error(new Error("controller-error"));
  out("controller-error", await settled(writer.write("z")), await settled(writer.closed), writer.desiredSize, await settled(stream.abort()));
}

{
  const stream = new WritableStream();
  const close = stream.close();
  out("direct-close", await settled(stream.close()), await settled(close), await settled(stream.abort()));
}

out(
  "brands",
  caught(() => WritableStream.prototype.getWriter.call({})),
  await settled(WritableStream.prototype.abort.call({})),
  await settled(/** @type {any} */ (Object.getOwnPropertyDescriptor(WritableStreamDefaultWriter.prototype, "ready")).get.call({})),
  caught(() => /** @type {any} */ (Object.getOwnPropertyDescriptor(WritableStreamDefaultWriter.prototype, "desiredSize")).get.call({})),
  caught(() => WritableStreamDefaultController.prototype.error.call({})),
);
out(
  "invalid",
  caught(() => new WritableStream(null)),
  caught(() => new WritableStream({ type: "bytes" })),
  caught(() => new WritableStream({ write: 1 })),
  caught(() => new WritableStream({ start: 1 })),
  caught(() => new WritableStream({}, { highWaterMark: -1 })),
  caught(() => new WritableStreamDefaultWriter(/** @type {any} */ ({}))),
);
{
  const classes = { WritableStream, WritableStreamDefaultWriter, TransformStream };
  const isInstance = (value, C) => value instanceof C;
  const stream = new WritableStream();
  const transform = new TransformStream();
  out(
    "by-value",
    isInstance(stream, classes.WritableStream),
    isInstance(stream.getWriter(), classes.WritableStreamDefaultWriter),
    isInstance(transform, classes.TransformStream),
    isInstance(transform.writable, classes.WritableStream),
    isInstance(stream, classes.TransformStream),
  );
}
console.log(log.join("\n"));
