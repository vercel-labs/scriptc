function describe(e: unknown): string {
  if (typeof e === "string") return `string:${e}`;
  const err = e as { code?: string; message?: string };
  return `${err.code}:${err.message}`;
}

function settle(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => "resolved",
    (e) => `rejected:${describe(e)}`,
  );
}

async function drain<T>(stream: ReadableStream<T>): Promise<T[]> {
  const out: T[] = [];
  const reader = stream.getReader();
  for (;;) {
    const result = await reader.read();
    if (result.done) return out;
    out.push(result.value);
  }
}

async function main(): Promise<void> {
  // A pipe writes every chunk, then closes the destination.
  {
    const events: string[] = [];
    const source = new ReadableStream<number>({
      start(c) {
        c.enqueue(1);
        c.enqueue(2);
        c.close();
      },
    });
    const sink = new WritableStream<number>({
      start() {
        events.push("start");
      },
      write(chunk) {
        events.push(`w:${chunk}`);
      },
      close() {
        events.push("close");
      },
    });
    console.log("pipe", await settle(source.pipeTo(sink)), events.join(","), source.locked, sink.locked);
  }

  // preventClose leaves the destination open for more writes.
  {
    const events: string[] = [];
    const source = new ReadableStream<string>({
      start(c) {
        c.enqueue("a");
        c.close();
      },
    });
    const sink = new WritableStream<string>({
      write(chunk) {
        events.push(`w:${chunk}`);
      },
      close() {
        events.push("close");
      },
    });
    console.log("preventClose", await settle(source.pipeTo(sink, { preventClose: true })), events.join(","));
    const writer = sink.getWriter();
    await writer.write("b");
    await writer.close();
    console.log("preventClose-after", events.join(","));
  }

  // A source error aborts the destination with the same value.
  {
    const boom = new Error("source-boom");
    const events: string[] = [];
    let seen: unknown;
    const source = new ReadableStream<number>({
      start(c) {
        c.enqueue(1);
      },
      pull(c) {
        c.error(boom);
      },
    });
    const sink = new WritableStream<number>({
      write(chunk) {
        events.push(`w:${chunk}`);
      },
      abort(reason) {
        seen = reason;
        events.push("abort");
      },
    });
    console.log("sourceError", await settle(source.pipeTo(sink)), events.join(","), seen === boom);
  }

  // A destination error cancels the source with the same value.
  {
    const boom = new RangeError("sink-boom");
    const events: string[] = [];
    let seen: unknown;
    const source = new ReadableStream<number>({
      start(c) {
        c.enqueue(1);
        c.enqueue(2);
      },
      cancel(reason) {
        seen = reason;
        events.push("cancel");
      },
    });
    const sink = new WritableStream<number>({
      write() {
        throw boom;
      },
    });
    console.log("destError", await settle(source.pipeTo(sink)), events.join(","), seen === boom);
  }

  // preventAbort keeps the destination open after a source error.
  {
    const events: string[] = [];
    const source = new ReadableStream<number>({
      start(c) {
        c.error(new Error("source-boom"));
      },
    });
    const sink = new WritableStream<number>({
      start() {
        events.push("start");
      },
      abort() {
        events.push("abort");
      },
    });
    console.log("preventAbort", await settle(source.pipeTo(sink, { preventAbort: true })), events.join(","));
  }

  // preventCancel leaves the source alone after a destination error.
  {
    const events: string[] = [];
    const source = new ReadableStream<number>({
      start(c) {
        c.enqueue(1);
      },
      cancel() {
        events.push("cancel");
      },
    });
    const sink = new WritableStream<number>({
      write() {
        throw new RangeError("sink-boom");
      },
    });
    console.log("preventCancel", await settle(source.pipeTo(sink, { preventCancel: true })), events.join(","));
  }

  // Locked streams refuse the pipe.
  {
    const source = new ReadableStream<number>();
    source.getReader();
    console.log("lockedSource", await settle(source.pipeTo(new WritableStream<number>())));
    const sink = new WritableStream<number>();
    sink.getWriter();
    console.log("lockedDest", await settle(new ReadableStream<number>().pipeTo(sink)));
  }

  // An abort signal stops the pipe and aborts both sides with its reason.
  {
    const events: string[] = [];
    const source = new ReadableStream<number>({
      pull() {
        return new Promise<void>(() => {});
      },
      cancel(reason) {
        events.push(`cancel:${describe(reason)}`);
      },
    });
    const sink = new WritableStream<number>({
      abort(reason) {
        events.push(`abort:${describe(reason)}`);
      },
    });
    const controller = new AbortController();
    const piping = source.pipeTo(sink, { signal: controller.signal });
    await Promise.resolve();
    controller.abort("stop");
    console.log("signal", await settle(piping), events.join(","));
  }

  // A signal that is already aborted refuses the pipe at once.
  {
    const controller = new AbortController();
    controller.abort("early");
    const source = new ReadableStream<number>();
    const sink = new WritableStream<number>();
    console.log("preAborted", await settle(source.pipeTo(sink, { signal: controller.signal })), source.locked, sink.locked);
  }

  // pipeThrough returns the transform's readable and locks the source.
  {
    const source = new ReadableStream<number>({
      start(c) {
        c.enqueue(1);
        c.enqueue(2);
        c.close();
      },
    });
    const transform = new TransformStream<number, string>({
      transform(chunk, c) {
        c.enqueue(`v${chunk}`);
      },
      flush(c) {
        c.enqueue("end");
      },
    });
    const through = source.pipeThrough(transform);
    console.log("pipeThrough", (await drain(through)).join(","), source.locked);
  }

  // The transform's own error reaches the pipe's reader.
  {
    const boom = new Error("transform-boom");
    const source = new ReadableStream<number>({
      start(c) {
        c.enqueue(1);
        c.close();
      },
    });
    const transform = new TransformStream<number, number>({
      transform() {
        throw boom;
      },
    });
    try {
      await drain(source.pipeThrough(transform));
      console.log("pipeThroughError", "resolved");
    } catch (e) {
      console.log("pipeThroughError", e === boom);
    }
  }
}

void main();
