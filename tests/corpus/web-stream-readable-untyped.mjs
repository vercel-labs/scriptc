// Web ReadableStream from untyped JavaScript: the classes as constructor
// values (globals and node:stream/web), their prototypes and brand checks,
// queuing strategies, default readers and controllers, tee, from() and
// async iteration, in Node's promise order.
import {
  ReadableStream as WebReadableStream,
  ReadableStreamDefaultReader,
  ReadableStreamDefaultController,
  CountQueuingStrategy,
  ByteLengthQueuingStrategy,
} from "node:stream/web";

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
const settled = (p) => p.then((v) => `ok:${v}`, (e) => `${e.name}:${e.code ?? ""}:${e.message}`);

out("classes", typeof ReadableStream, ReadableStream === WebReadableStream, ReadableStream.name, ReadableStream.length);
out("illegal", caught(() => new ReadableStreamDefaultController()), caught(() => /** @type {any} */ (ReadableStream)()));
out("prototype", Object.keys(ReadableStreamDefaultReader.prototype).join(","), Object.keys(ReadableStreamDefaultController.prototype).join(","));

{
  /** @type {any} */
  let controller;
  const stream = new ReadableStream({ start(c) { controller = c; } }, new CountQueuingStrategy({ highWaterMark: 2 }));
  out("strategy", controller.desiredSize, stream instanceof ReadableStream, controller instanceof ReadableStreamDefaultController);
  controller.enqueue("a");
  controller.enqueue("b");
  controller.enqueue("c");
  out("queued", controller.desiredSize, Object.prototype.toString.call(stream), Object.prototype.toString.call(controller));
  const reader = new ReadableStreamDefaultReader(stream);
  out("locked", stream.locked, caught(() => stream.getReader()), reader instanceof ReadableStreamDefaultReader);
  const first = await reader.read();
  out("read", first.value, first.done, controller.desiredSize);
  controller.close();
  const rest = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    rest.push(value);
  }
  out("rest", rest.join(","), await settled(reader.closed), controller.desiredSize);
  reader.releaseLock();
  out("released", stream.locked, await settled(reader.read()));
}

{
  const sizes = new ByteLengthQueuingStrategy({ highWaterMark: 8 });
  /** @type {any} */
  let controller;
  const stream = new ReadableStream({ start(c) { controller = c; } }, sizes);
  controller.enqueue(new Uint8Array(3));
  out("bytes", sizes.highWaterMark, sizes.size(new Uint8Array(5)), controller.desiredSize, sizes.size.name);
  controller.error(new Error("broken"));
  out("errored", controller.desiredSize, await settled(stream.getReader().read()));
}

{
  const order = [];
  const stream = new ReadableStream({
    start() { order.push("start"); },
    pull(c) {
      order.push(`pull ${c.desiredSize}`);
      c.enqueue(order.length);
      if (order.length > 3) c.close();
    },
    cancel(reason) { order.push(`cancel ${reason}`); },
  });
  order.push("constructed");
  await Promise.resolve();
  order.push("tick");
  const values = [];
  for await (const v of stream) values.push(v);
  out("pulls", order.join(" | "), values.join(","));
}

{
  const [a, b] = ReadableStream.from(["x", "y", "z"]).tee();
  const left = [];
  for await (const v of a) left.push(v);
  const right = [];
  const reader = b.getReader();
  for (let r = await reader.read(); !r.done; r = await reader.read()) right.push(r.value);
  out("tee", left.join(""), right.join(""));
}

{
  const canceled = [];
  const stream = ReadableStream.from({
    [Symbol.iterator]() {
      let n = 0;
      return {
        next: () => ({ value: n++, done: false }),
        return: (reason) => {
          canceled.push(`return ${reason}`);
          return { done: true };
        },
      };
    },
  });
  const taken = [];
  for await (const v of stream) {
    taken.push(v);
    if (v === 2) break;
  }
  out("from-break", taken.join(","), canceled.join(","), stream.locked);
}

out(
  "brands",
  caught(() => ReadableStream.prototype.getReader.call({})),
  await settled(ReadableStream.prototype.cancel.call({})),
  await settled(/** @type {any} */ (Object.getOwnPropertyDescriptor(ReadableStreamDefaultReader.prototype, "closed")).get.call({})),
  caught(() => /** @type {any} */ (Object.getOwnPropertyDescriptor(ReadableStream.prototype, "locked")).get.call(1)),
);
out(
  "invalid",
  caught(() => new ReadableStream(null)),
  caught(() => new ReadableStream({}, { highWaterMark: -1 })),
  caught(() => new ReadableStream({ pull: 1 })),
  caught(() => new CountQueuingStrategy({})),
);
console.log(log.join("\n"));
