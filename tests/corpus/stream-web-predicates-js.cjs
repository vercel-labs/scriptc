// node:stream's utility predicates over WHATWG streams in a checked-dynamic
// program: the global classes and the node:stream/web imports are untyped
// constructor values, and the predicates judge each stream at run time by
// the same state their class answers: readable until close or error,
// disturbed by a read, cancel or pipe, writable while the writable side is
// open, null for the side a stream does not have and for isDestroyed.
const stream = require("node:stream");
const { ReadableStream: ImportedReadable, WritableStream: ImportedWritable } = require("node:stream/web");

function flags(value) {
  return [
    stream.isDestroyed(value),
    stream.isErrored(value),
    stream.isDisturbed(value),
    stream.isReadable(value),
    stream.isWritable(value),
  ]
    .map(String)
    .join(" ");
}

async function main() {
  const chunks = new ReadableStream({
    start(controller) {
      controller.enqueue("a");
      controller.enqueue("b");
      controller.close();
    },
  });
  console.log("readable fresh", flags(chunks), stream.Readable.isDisturbed(chunks));
  const reader = chunks.getReader();
  console.log("readable locked", flags(chunks));
  const first = await reader.read();
  console.log("readable read1", first.value, flags(chunks), stream.Readable.isDisturbed(chunks));
  await reader.read();
  console.log("readable read2", flags(chunks));
  const done = await reader.read();
  console.log("readable done", done.done, flags(chunks));
  reader.releaseLock();
  console.log("readable released", flags(chunks));

  const cancelled = new ImportedReadable({
    start(controller) {
      controller.enqueue("a");
    },
  });
  await cancelled.cancel();
  console.log("readable cancelled", flags(cancelled));

  let errored;
  const failing = new ReadableStream({
    start(controller) {
      errored = controller;
    },
  });
  errored.error(new RangeError("readable boom"));
  console.log("readable errored unread", flags(failing));

  const iterated = new ReadableStream({
    start(controller) {
      controller.enqueue("x");
      controller.close();
    },
  });
  for await (const chunk of iterated) console.log("iterated chunk", chunk);
  console.log("iterated after", flags(iterated));

  const sink = new WritableStream({ write() {} });
  console.log("writable fresh", flags(sink));
  const writer = sink.getWriter();
  console.log("writable locked", flags(sink));
  await writer.write("a");
  console.log("writable wrote", flags(sink));
  await writer.close();
  console.log("writable closed", flags(sink));

  const failingSink = new ImportedWritable({
    write() {
      throw new Error("writable boom");
    },
  });
  const failingWriter = failingSink.getWriter();
  await failingWriter.write("a").catch(() => {});
  console.log("writable errored", flags(failingSink));

  const aborted = new WritableStream({});
  await aborted.abort(new Error("abort"));
  console.log("writable aborted", flags(aborted));

  const pair = new TransformStream();
  console.log("transform pair", flags(pair));
  console.log("transform sides", flags(pair.readable), "|", flags(pair.writable));
  const pairWriter = pair.writable.getWriter();
  const reading = pair.readable.getReader().read();
  await pairWriter.write("a");
  await pairWriter.close();
  console.log("transform read", (await reading).value);
  console.log("transform used", flags(pair), "|", flags(pair.readable), "|", flags(pair.writable));
  console.log("transform like", flags(new TextEncoderStream()), flags(new TextDecoderStream()));

  const empty = new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
  console.log("reader", flags(empty.getReader()));
  console.log("writer", flags(new WritableStream({}).getWriter()));

  const piped = new ReadableStream({
    start(controller) {
      controller.enqueue("a");
      controller.close();
    },
  });
  const pipedSink = new WritableStream({ write() {} });
  console.log("pipe before", flags(piped), "|", flags(pipedSink));
  await piped.pipeTo(pipedSink);
  console.log("pipe after", flags(piped), "|", flags(pipedSink));

  const from = ReadableStream.from(["x", "y"]);
  const fromReader = from.getReader();
  console.log("from fresh", flags(from));
  await fromReader.read();
  console.log("from read", flags(from));
  await fromReader.read();
  console.log("from drained", flags(from));

  const response = new Response("hello");
  const body = response.body;
  console.log("response body", flags(body));
  console.log("response text", await response.text(), flags(body));

  const values = [new ReadableStream(), new WritableStream(), new TransformStream()];
  for (const value of values) console.log("untyped", flags(value));
}

main();
