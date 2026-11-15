// The TypeScript twin of compat-web-stream-members.mjs: members of the
// web stream classes from a typed source. The default controllers of
// readable, writable and transform streams, the default reader and
// writer, cancel, abort, close, pipeTo, pipeThrough and tee. Read results
// are printed field by field. A typed source cannot yet reach the two
// queuing strategies, a strategy passed to a stream constructor,
// TextEncoderStream and TextDecoderStream, `instanceof` a controller
// class, or a stream method read as a value; the JavaScript program
// covers those.

// ReadableStreamDefaultController: desiredSize falls as chunks queue.
const sizes: Array<number | null> = [];
const counted = new ReadableStream<string>({
  start(controller) {
    sizes.push(controller.desiredSize);
    controller.enqueue("a");
    sizes.push(controller.desiredSize);
    controller.close();
  },
});
console.log(counted.locked);
const reader = counted.getReader();
const first = await reader.read();
const second = await reader.read();
console.log(counted.locked, first.value, first.done, second.value, second.done, sizes.join(","));
await reader.closed;
reader.releaseLock();
console.log(counted.locked);

// controller.error() rejects the pending read.
const failing = new ReadableStream<string>({
  start(controller) {
    controller.error(new Error("bad source"));
  },
});
try {
  await failing.getReader().read();
} catch (error) {
  console.log((error as Error).message);
}

// cancel() on the stream and on its reader reaches the source.
const reasons: string[] = [];
const cancelled = new ReadableStream<string>({
  cancel(reason) {
    reasons.push(String(reason));
  },
});
await cancelled.cancel("stream");
const cancelledByReader = new ReadableStream<string>({
  cancel(reason) {
    reasons.push(String(reason));
  },
});
const cancelReader = cancelledByReader.getReader();
await cancelReader.cancel("reader");
console.log(reasons.join(","), (await cancelReader.read()).done);

// tee(), pipeTo() and pipeThrough().
const letters = (): ReadableStream<string> =>
  new ReadableStream<string>({
    start(controller) {
      controller.enqueue("a");
      controller.enqueue("b");
      controller.close();
    },
  });
const [left, right] = letters().tee();
console.log((await left.getReader().read()).value, (await right.getReader().read()).value);
const sunk: string[] = [];
await letters().pipeTo(
  new WritableStream<string>({
    write(chunk) {
      sunk.push(chunk);
    },
  }),
);
console.log(sunk.join(""));
const upper = new TransformStream<string, string>({
  transform(chunk, controller) {
    controller.enqueue(chunk.toUpperCase());
  },
});
const piped: string[] = [];
for await (const value of letters().pipeThrough(upper)) piped.push(value);
console.log(piped.join(""));

// TransformStream: readable and writable, and the default controller's
// desiredSize, terminate() and error().
const terminating = new TransformStream<string, string>({
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
const erroring = new TransformStream<string, string>({
  transform(_chunk, controller) {
    controller.error(new Error("bad transform"));
  },
});
erroring.writable.getWriter().write("x").catch(() => {});
try {
  await erroring.readable.getReader().read();
} catch (error) {
  console.log((error as Error).message);
}

// WritableStream: the default writer, the default controller and abort.
const written: string[] = [];
const sink = new WritableStream<string>({
  start(controller) {
    console.log(controller.signal.aborted);
  },
  write(chunk) {
    written.push(chunk);
  },
});
console.log(sink.locked, typeof WritableStreamDefaultController);
const writer = sink.getWriter();
console.log(sink.locked, writer.desiredSize);
await writer.ready;
await writer.write("a");
await writer.close();
await writer.closed;
writer.releaseLock();
console.log(sink.locked, written.join(""));
let closed = false;
await new WritableStream<string>({
  close() {
    closed = true;
  },
}).close();
console.log(closed);
const aborts: string[] = [];
await new WritableStream<string>({
  abort(reason) {
    aborts.push(String(reason));
  },
}).abort("stream");
await new WritableStream<string>({
  abort(reason) {
    aborts.push(String(reason));
  },
})
  .getWriter()
  .abort("writer");
console.log(aborts.join(","));
const errored = new WritableStream<string>({
  write(chunk, controller) {
    controller.error(new Error(`bad sink ${chunk}`));
  },
});
const erroredWriter = errored.getWriter();
try {
  await erroredWriter.write("x");
  await erroredWriter.write("y");
} catch (error) {
  console.log((error as Error).message);
}
