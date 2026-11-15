// Members of the web stream classes: the two queuing strategies, the
// default controllers of readable, writable and transform streams, the
// default reader and writer, cancel, abort, close, pipeTo, pipeThrough
// and tee, and the members of TextEncoderStream and TextDecoderStream.
// Read results are printed field by field.
const byteStrategy = new ByteLengthQueuingStrategy({ highWaterMark: 16 });
const countStrategy = new CountQueuingStrategy({ highWaterMark: 2 });
console.log(byteStrategy.highWaterMark, byteStrategy.size(new Uint8Array(3)), countStrategy.highWaterMark, countStrategy.size("x"));

// ReadableStreamDefaultController: desiredSize falls as chunks queue.
const sizes = [];
const counted = new ReadableStream(
  {
    start(controller) {
      sizes.push(controller.desiredSize);
      controller.enqueue("a");
      sizes.push(controller.desiredSize);
      controller.close();
    },
  },
  { highWaterMark: 2 },
);
console.log(counted.locked);
const reader = counted.getReader();
const first = await reader.read();
const second = await reader.read();
console.log(counted.locked, first.value, first.done, second.value, second.done, sizes.join(","));
await reader.closed;
reader.releaseLock();
console.log(counted.locked);

// controller.error() rejects the pending read.
const failing = new ReadableStream({
  start(controller) {
    controller.error(new Error("bad source"));
  },
});
try {
  await failing.getReader().read();
} catch (error) {
  console.log(error.message);
}

// cancel() on the stream and on its reader reaches the source.
const reasons = [];
const cancelled = new ReadableStream({
  cancel(reason) {
    reasons.push(reason);
  },
});
await cancelled.cancel("stream");
const cancelledByReader = new ReadableStream({
  cancel(reason) {
    reasons.push(reason);
  },
});
const cancelReader = cancelledByReader.getReader();
await cancelReader.cancel("reader");
console.log(reasons.join(","), (await cancelReader.read()).done);

// tee(), pipeTo() and pipeThrough().
const letters = () =>
  new ReadableStream({
    start(controller) {
      controller.enqueue("a");
      controller.enqueue("b");
      controller.close();
    },
  });
const [left, right] = letters().tee();
console.log((await left.getReader().read()).value, (await right.getReader().read()).value);
const sunk = [];
await letters().pipeTo(
  new WritableStream({
    write(chunk) {
      sunk.push(chunk);
    },
  }),
);
console.log(sunk.join(""));
const upper = new TransformStream({
  transform(chunk, controller) {
    controller.enqueue(chunk.toUpperCase());
  },
});
console.log(typeof upper.readable.getReader, typeof upper.writable.getWriter);
const piped = [];
for await (const value of letters().pipeThrough(upper)) piped.push(value);
console.log(piped.join(""));

// TransformStreamDefaultController: desiredSize, terminate() and error().
const terminating = new TransformStream({
  transform(chunk, controller) {
    console.log(typeof controller.desiredSize);
    controller.enqueue(chunk);
    controller.terminate();
  },
});
terminating.writable.getWriter().write("only").catch(() => {});
const terminatedReader = terminating.readable.getReader();
const kept = await terminatedReader.read();
const ended = await terminatedReader.read();
console.log(kept.value, kept.done, ended.done);
const erroring = new TransformStream({
  transform(_chunk, controller) {
    controller.error(new Error("bad transform"));
  },
});
erroring.writable.getWriter().write("x").catch(() => {});
try {
  await erroring.readable.getReader().read();
} catch (error) {
  console.log(error.message);
}

// WritableStream: the default writer, the default controller and abort.
const written = [];
let sinkController;
const sink = new WritableStream({
  start(controller) {
    sinkController = controller;
  },
  write(chunk) {
    written.push(chunk);
  },
});
console.log(sink.locked, sinkController.signal.aborted, sinkController instanceof WritableStreamDefaultController);
const writer = sink.getWriter();
console.log(sink.locked, writer.desiredSize);
await writer.ready;
await writer.write("a");
await writer.close();
await writer.closed;
writer.releaseLock();
console.log(sink.locked, written.join(""));
let closed = false;
await new WritableStream({
  close() {
    closed = true;
  },
}).close();
console.log(closed);
const aborts = [];
await new WritableStream({
  abort(reason) {
    aborts.push(reason);
  },
}).abort("stream");
await new WritableStream({
  abort(reason) {
    aborts.push(reason);
  },
})
  .getWriter()
  .abort("writer");
console.log(aborts.join(","));
let erroredController;
const errored = new WritableStream({
  start(controller) {
    erroredController = controller;
  },
});
erroredController.error(new Error("bad sink"));
try {
  await errored.getWriter().write("x");
} catch (error) {
  console.log(error.message);
}

// The text codec streams.
const encoder = new TextEncoderStream();
const decoder = new TextDecoderStream("utf-8", { fatal: true });
console.log(encoder.encoding, typeof encoder.readable.getReader, typeof encoder.writable.getWriter);
console.log(decoder.encoding, decoder.fatal, decoder.ignoreBOM, typeof decoder.readable.getReader, typeof decoder.writable.getWriter);
