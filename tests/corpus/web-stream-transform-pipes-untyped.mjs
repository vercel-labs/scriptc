// Web TransformStream and pipes from untyped JavaScript: transformers with
// start, transform, flush and cancel, backpressure between the sides,
// controller errors and terminate, pipeTo and pipeThrough with their
// options, abort signals, own properties on streams and method wrappers
// over them, a transformer start that returns a thenable, and encoder and
// decoder streams, in Node's promise order.
import { TransformStream as WebTransformStream, TransformStreamDefaultController } from "node:stream/web";

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
const collect = async (readable) => {
  const got = [];
  for await (const chunk of readable) got.push(chunk);
  return got.join(",");
};

out("classes", TransformStream === WebTransformStream, TransformStream.name, TransformStream.length, caught(() => new TransformStreamDefaultController()));
out("prototype", Object.keys(TransformStream.prototype).join(","), Object.keys(TransformStreamDefaultController.prototype).join(","));

{
  const order = [];
  const t = new TransformStream({
    start(c) {
      order.push(`start ${c.desiredSize}`);
      c.enqueue("S");
    },
    transform(chunk, c) {
      order.push(`transform ${chunk}`);
      c.enqueue(chunk.toUpperCase());
    },
    flush(c) {
      order.push("flush");
      c.enqueue("F");
    },
  });
  const writer = t.writable.getWriter();
  writer.write("a");
  writer.write("b");
  writer.close();
  out("transform", await collect(t.readable), order.join(" | "), await settled(writer.closed));
}

{
  const t = new TransformStream({}, undefined, { highWaterMark: 1 });
  const writer = t.writable.getWriter();
  out("backpressure", writer.desiredSize, t.readable.locked);
  const first = writer.write("x");
  const second = writer.write("y");
  out("queued", writer.desiredSize);
  const reader = t.readable.getReader();
  out("read", (await reader.read()).value, (await reader.read()).value, await settled(first), await settled(second));
}

{
  const failure = new Error("transform-failure");
  const t = new TransformStream({ transform() { throw failure; } });
  const writer = t.writable.getWriter();
  const reader = t.readable.getReader();
  const read = settled(reader.read());
  const write = settled(writer.write("z"));
  out("transform-error", await write, await read, await settled(writer.closed));
}

{
  /** @type {any} */
  let controller;
  const t = new TransformStream({ start(c) { controller = c; } });
  controller.enqueue("before");
  controller.terminate();
  const reader = t.readable.getReader();
  out("terminate", (await reader.read()).value, (await reader.read()).done, await settled(t.writable.getWriter().write("after")), caught(() => controller.enqueue("late")));
}

{
  const cancels = [];
  const t = new TransformStream({ cancel(reason) { cancels.push(`cancel ${reason}`); } });
  out("cancel", await settled(t.readable.cancel("stop")), cancels.join(","), await settled(t.writable.getWriter().closed));
}

{
  const source = ReadableStream.from(["p", "q", "r"]);
  const got = [];
  const sink = new WritableStream({ write(chunk) { got.push(chunk); } });
  const piped = source.pipeThrough(new TransformStream({ transform(chunk, c) { c.enqueue(chunk + chunk); } })).pipeTo(sink);
  out("pipe", await settled(piped), got.join(","), source.locked);
}

{
  const source = new ReadableStream({ start(c) { c.enqueue(1); c.close(); } });
  const sink = new WritableStream();
  out("prevent-close", await settled(source.pipeTo(sink, { preventClose: true })), sink.locked, await settled(sink.getWriter().write(2)));
}

{
  const failure = new Error("source-failure");
  const source = new ReadableStream({ start(c) { c.error(failure); } });
  const aborts = [];
  const sink = new WritableStream({ abort(reason) { aborts.push(reason === failure); } });
  out("source-error", await settled(source.pipeTo(sink)), aborts.join(","));
}

{
  const controller = new AbortController();
  const reason = new Error("signal");
  const source = new ReadableStream({ pull() {}, cancel(e) { out("signal-cancel", e === reason); } }, { highWaterMark: 0 });
  const sink = new WritableStream({ abort(e) { out("signal-abort", e === reason); } });
  const piped = source.pipeTo(sink, { signal: controller.signal });
  await Promise.resolve();
  controller.abort(reason);
  out("signal", await settled(piped), source.locked, sink.locked);
}

{
  const source = ReadableStream.from(["own"]);
  const sink = new WritableStream();
  /** @type {any} */ (source).getReader = () => { throw new Error("public reader"); };
  /** @type {any} */ (sink).tag = "kept";
  await source.pipeTo(sink);
  out("own-properties", /** @type {any} */ (sink).tag, typeof /** @type {any} */ (source).getReader, caught(() => { /** @type {any} */ (source).locked = true; }));
}

{
  // An own property that wraps the saved prototype method reaches the
  // class's method.
  const calls = [];
  const wrap = (target, name, method) => {
    target[name] = function (...args) {
      calls.push(name);
      return method.apply(this, args);
    };
  };
  const writable = new WritableStream({ write(chunk) { calls.push(`sink:${chunk}`); } });
  wrap(writable, "getWriter", WritableStream.prototype.getWriter);
  const writer = writable.getWriter();
  wrap(writer, "write", WritableStreamDefaultWriter.prototype.write);
  wrap(writer, "close", WritableStreamDefaultWriter.prototype.close);
  await writer.write("a");
  await writer.close();
  const readable = ReadableStream.from(["b"]);
  wrap(readable, "getReader", ReadableStream.prototype.getReader);
  const reader = readable.getReader();
  wrap(reader, "read", ReadableStreamDefaultReader.prototype.read);
  const first = await reader.read();
  const t = new TransformStream({
    transform(chunk, controller) {
      wrap(controller, "enqueue", TransformStreamDefaultController.prototype.enqueue);
      controller.enqueue(`${chunk}!`);
    },
  });
  t.writable.getWriter().write("c");
  const transformed = await t.readable.getReader().read();
  out("wrappers", calls.join(","), first.value, transformed.value, writable.locked);
}

{
  // A transformer start that returns a thenable: both sides start when it
  // settles, and its rejection errors the stream.
  const order = [];
  const later = { then(resolve) { order.push("then"); setTimeout(() => { order.push("resolve"); resolve(); }, 0); } };
  const t = new TransformStream({ start() { return later; }, transform(chunk, c) { order.push(`transform:${chunk}`); c.enqueue(chunk); } });
  Promise.resolve().then(() => order.push("tick1")).then(() => order.push("tick2")).then(() => order.push("tick3"));
  const written = t.writable.getWriter().write("x").then(() => order.push("written"));
  const read = await t.readable.getReader().read();
  await written;
  out("start-thenable", order.join(","), read.value);
  const ticks = [];
  const sync = new TransformStream({ start() { return { then(resolve) { ticks.push("then"); resolve(); } }; }, transform(chunk, c) { ticks.push("transform"); c.enqueue(chunk); } });
  Promise.resolve().then(() => ticks.push("tick1")).then(() => ticks.push("tick2")).then(() => ticks.push("tick3")).then(() => ticks.push("tick4"));
  sync.writable.getWriter().write("z").then(() => ticks.push("written"));
  sync.readable.getReader().read().then(() => ticks.push("read"));
  await new Promise((r) => setTimeout(r, 0));
  out("start-thenable-ticks", ticks.join(","));
  const failing = new TransformStream({ start() { return { then(_, reject) { reject(new Error("start failed")); } }; } });
  out("start-thenable-reject", await settled(failing.writable.getWriter().write("y")), await settled(failing.readable.getReader().read()));
  const throwing = new TransformStream({ start() { return { get then() { throw new Error("then getter"); } }; } });
  out("start-then-getter", await settled(throwing.writable.getWriter().write("y")));
  const plain = new TransformStream({ start() { return { then: 1 }; } });
  const pending = plain.readable.getReader().read();
  out("start-object", await settled(plain.writable.getWriter().write("p")), (await pending).value);
}

out(
  "invalid",
  await settled(ReadableStream.from([]).pipeTo(/** @type {any} */ ({}))),
  caught(() => ReadableStream.from([]).pipeThrough(/** @type {any} */ ({}))),
  caught(() => new TransformStream({ readableType: "bytes" })),
  caught(() => new TransformStream({ transform: 1 })),
);

{
  const bytes = [];
  await ReadableStream.from(["hé", "\ud83d", "\ude00", "\ud800"])
    .pipeThrough(new TextEncoderStream())
    .pipeTo(new WritableStream({ write(chunk) { bytes.push(Array.from(chunk).join(".")); } }));
  out("encoder", bytes.join(" | "), new TextEncoderStream().encoding, Object.prototype.toString.call(new TextEncoderStream()));
  const text = [];
  await ReadableStream.from([new Uint8Array([0xe2, 0x82]), new Uint8Array([0xac, 0x21]), new Uint8Array([0xf0])])
    .pipeThrough(new TextDecoderStream())
    .pipeTo(new WritableStream({ write(chunk) { text.push(chunk); } }));
  const decoder = new TextDecoderStream("utf-8", { fatal: true });
  out("decoder", text.join("|"), decoder.encoding, decoder.fatal, decoder.ignoreBOM, caught(() => new TextDecoderStream("nope")));
}
console.log(log.join("\n"));
