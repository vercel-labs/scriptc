// node:stream's utility predicates over WHATWG streams (ReadableStream,
// WritableStream, TransformStream, TextEncoderStream, their readers and
// writers and a Response body): each state Node's
// kIs* getters report — readable until the close is processed or an error
// arrives, disturbed once a read, a cancel or a pipe starts, writable
// while the writable side is open — and the nulls a web stream answers for
// the side it does not have and for isDestroyed, which asks only Node
// streams.
import * as stream from "node:stream";
import { Readable } from "node:stream";

const flags = (value: unknown): string =>
  [
    stream.isDestroyed(value),
    stream.isErrored(value),
    stream.isDisturbed(value),
    stream.isReadable(value),
    stream.isWritable(value),
  ]
    .map((answer) => String(answer))
    .join(" ");

async function main(): Promise<void> {
  // A ReadableStream: readable while chunks remain, disturbed from the
  // first read, closed once the queue drains.
  {
    const chunks = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("a");
        controller.enqueue("b");
        controller.close();
      },
    });
    console.log("readable fresh", flags(chunks), Readable.isDisturbed(chunks));
    const reader = chunks.getReader();
    console.log("readable locked", flags(chunks));
    const first = await reader.read();
    console.log("readable read1", first.value, flags(chunks), Readable.isDisturbed(chunks));
    const second = await reader.read();
    console.log("readable read2", second.value, flags(chunks));
    const done = await reader.read();
    console.log("readable done", done.done, flags(chunks));
    reader.releaseLock();
    console.log("readable released", flags(chunks));
  }

  // Cancel disturbs and closes; an error reports through isErrored; async
  // iteration disturbs.
  {
    const cancelled = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("a");
      },
    });
    await cancelled.cancel();
    console.log("readable cancelled", flags(cancelled));
  }
  {
    const failing = new ReadableStream<string>({
      start(controller) {
        controller.error(new Error("readable boom"));
      },
    });
    console.log("readable errored unread", flags(failing));
  }
  {
    const iterated = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("x");
        controller.close();
      },
    });
    for await (const chunk of iterated) console.log("iterated chunk", chunk);
    console.log("iterated after", flags(iterated));
  }

  // A WritableStream: writable while open, closed after close(), errored
  // after a failing write or abort(). Writes never disturb.
  {
    const sink = new WritableStream<string>({ write() {} });
    console.log("writable fresh", flags(sink));
    const writer = sink.getWriter();
    console.log("writable locked", flags(sink));
    await writer.write("a");
    console.log("writable wrote", flags(sink));
    await writer.close();
    console.log("writable closed", flags(sink));
  }
  {
    const failing = new WritableStream<string>({
      write() {
        throw new Error("writable boom");
      },
    });
    const writer = failing.getWriter();
    await writer.write("a").catch(() => {});
    console.log("writable errored", flags(failing));
  }
  {
    const aborted = new WritableStream<string>({});
    await aborted.abort(new Error("abort"));
    console.log("writable aborted", flags(aborted));
  }

  // A TransformStream answers no side itself: its readable and writable
  // are separate streams, and TextEncoderStream is a TransformStream.
  {
    const pair = new TransformStream<string, string>();
    console.log("transform pair", flags(pair));
    console.log("transform sides", flags(pair.readable), "|", flags(pair.writable));
    const writer = pair.writable.getWriter();
    const reading = pair.readable.getReader().read();
    await writer.write("a");
    await writer.close();
    console.log("transform read", (await reading).value);
    console.log(
      "transform used",
      flags(pair),
      "|",
      flags(pair.readable),
      "|",
      flags(pair.writable),
    );
  }
  {
    const encoder = new TextEncoderStream();
    console.log(
      "encoder",
      flags(encoder),
      "|",
      flags(encoder.readable),
      "|",
      flags(encoder.writable),
    );
  }

  // Readers and writers answer as objects with no stream side.
  {
    const chunks = new ReadableStream<string>({
      start(controller) {
        controller.close();
      },
    });
    console.log("reader", flags(chunks.getReader()));
    const sink = new WritableStream<string>({});
    console.log("writer", flags(sink.getWriter()));
  }

  // pipeTo and pipeThrough disturb their source and end their sides.
  {
    const chunks = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("a");
        controller.close();
      },
    });
    const sink = new WritableStream<string>({ write() {} });
    console.log("pipe before", flags(chunks), "|", flags(sink));
    await chunks.pipeTo(sink);
    console.log("pipe after", flags(chunks), "|", flags(sink));
  }
  {
    const chunks = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("a");
        controller.close();
      },
    });
    const through = chunks.pipeThrough(new TransformStream<string, string>());
    console.log("through before", flags(chunks), "|", flags(through));
    const values: string[] = [];
    for await (const chunk of through) values.push(chunk);
    console.log("through values", values.join(","), "|", flags(chunks), "|", flags(through));
  }

  // ReadableStream.from: readable until its last queued chunk is read.
  {
    const from = ReadableStream.from(["x", "y"]);
    console.log("from fresh", flags(from));
    const reader = from.getReader();
    await reader.read();
    console.log("from read", flags(from));
    await reader.read();
    console.log("from drained", flags(from));
  }

  // A Response body is a web ReadableStream: consuming it disturbs and
  // closes it.
  {
    const response = new Response("hello");
    const body = response.body;
    console.log("response body", flags(body));
    const text = await response.text();
    console.log("response text", text, flags(body));
  }

  // A body piped to a backpressured sink is disturbed as the pipe starts,
  // before its first read reaches the body.
  {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
          controller.enqueue(new Uint8Array([2]));
          controller.close();
        },
      }),
    );
    const body = response.body!;
    const sink = new WritableStream(
      {
        async write() {
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
        },
      },
      { highWaterMark: 1 },
    );
    const pipe = body.pipeTo(sink);
    console.log("piped body during", flags(body), "|", response.bodyUsed);
    await pipe;
    console.log("piped body after", flags(body), "|", response.bodyUsed);
  }

  // Untyped values take the same answers.
  {
    const values: unknown[] = [
      new ReadableStream<string>(),
      new WritableStream<string>(),
      new TransformStream(),
    ];
    for (const value of values) console.log("untyped", flags(value));
  }
}

void main();
