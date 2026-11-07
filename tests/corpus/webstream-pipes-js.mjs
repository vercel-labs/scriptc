function describe(e) {
  if (typeof e === "string") return `string:${e}`;
  return `${e && e.code}:${e && e.message}`;
}

function settle(p) {
  return p.then(
    () => "resolved",
    (e) => `rejected:${describe(e)}`,
  );
}

async function drain(stream) {
  const out = [];
  const reader = stream.getReader();
  for (;;) {
    const result = await reader.read();
    if (result.done) return out;
    out.push(result.value);
  }
}

async function main() {
  // A pipe writes every chunk, then closes the destination.
  {
    const events = [];
    const source = new ReadableStream({ start(c) { c.enqueue(1); c.enqueue(2); c.close(); } });
    const sink = new WritableStream({
      start() { events.push("start"); },
      write(chunk) { events.push(`w:${chunk}`); },
      close() { events.push("close"); },
    });
    console.log("pipe", await settle(source.pipeTo(sink)), events.join(","), source.locked, sink.locked);
  }

  // preventClose leaves the destination open for more writes.
  {
    const events = [];
    const source = new ReadableStream({ start(c) { c.enqueue("a"); c.close(); } });
    const sink = new WritableStream({
      write(chunk) { events.push(`w:${chunk}`); },
      close() { events.push("close"); },
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
    const events = [];
    let seen;
    const source = new ReadableStream({
      start(c) { c.enqueue(1); },
      pull(c) { c.error(boom); },
    });
    const sink = new WritableStream({
      write(chunk) { events.push(`w:${chunk}`); },
      abort(reason) { seen = reason; events.push("abort"); },
    });
    console.log("sourceError", await settle(source.pipeTo(sink)), events.join(","), seen === boom);
  }

  // A destination error cancels the source with the same value.
  {
    const boom = new RangeError("sink-boom");
    const events = [];
    let seen;
    const source = new ReadableStream({
      start(c) { c.enqueue(1); c.enqueue(2); },
      cancel(reason) { seen = reason; events.push("cancel"); },
    });
    const sink = new WritableStream({ write() { throw boom; } });
    console.log("destError", await settle(source.pipeTo(sink)), events.join(","), seen === boom);
  }

  // preventAbort keeps the destination open after a source error.
  {
    const events = [];
    const source = new ReadableStream({ start(c) { c.error(new Error("source-boom")); } });
    const sink = new WritableStream({
      start() { events.push("start"); },
      abort() { events.push("abort"); },
    });
    console.log("preventAbort", await settle(source.pipeTo(sink, { preventAbort: true })), events.join(","));
  }

  // preventCancel leaves the source alone after a destination error.
  {
    const events = [];
    const source = new ReadableStream({
      start(c) { c.enqueue(1); },
      cancel() { events.push("cancel"); },
    });
    const sink = new WritableStream({ write() { throw new RangeError("sink-boom"); } });
    console.log("preventCancel", await settle(source.pipeTo(sink, { preventCancel: true })), events.join(","));
  }

  // Locked streams refuse the pipe.
  {
    const source = new ReadableStream();
    source.getReader();
    console.log("lockedSource", await settle(source.pipeTo(new WritableStream())));
    const sink = new WritableStream();
    sink.getWriter();
    console.log("lockedDest", await settle(new ReadableStream().pipeTo(sink)));
  }

  // A destination that is not a WritableStream refuses the pipe.
  for (const bad of [5, null, undefined, {}]) {
    console.log("notWritable", typeof bad, await settle(new ReadableStream().pipeTo(bad)));
  }

  // An options value that is not an object refuses the pipe.
  for (const bad of [5, "x", true]) {
    console.log("badOptions", typeof bad, await settle(new ReadableStream().pipeTo(new WritableStream(), bad)));
  }

  // An abort signal stops the pipe and aborts both sides with its reason.
  {
    const events = [];
    const source = new ReadableStream({
      pull() { return new Promise(() => {}); },
      cancel(reason) { events.push(`cancel:${describe(reason)}`); },
    });
    const sink = new WritableStream({
      abort(reason) { events.push(`abort:${describe(reason)}`); },
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
    const source = new ReadableStream();
    const sink = new WritableStream();
    console.log("preAborted", await settle(source.pipeTo(sink, { signal: controller.signal })), source.locked, sink.locked);
  }

  // A signal that is not an AbortSignal refuses the pipe.
  for (const bad of [5, {}, null]) {
    try {
      const p = new ReadableStream().pipeTo(new WritableStream(), { signal: bad });
      console.log("badSignal", typeof bad, await settle(p));
    } catch (e) {
      console.log("badSignal", typeof bad, `threw:${describe(e)}`);
    }
  }

  // pipeThrough returns the transform's readable and locks the source.
  {
    const source = new ReadableStream({ start(c) { c.enqueue(1); c.enqueue(2); c.close(); } });
    const transform = new TransformStream({
      transform(chunk, c) { c.enqueue(`v${chunk}`); },
      flush(c) { c.enqueue("end"); },
    });
    const through = source.pipeThrough(transform);
    console.log("pipeThrough", (await drain(through)).join(","), source.locked);
  }

  // pipeThrough takes a plain readable/writable pair.
  {
    const source = new ReadableStream({ start(c) { c.enqueue(1); c.close(); } });
    const transform = new TransformStream();
    const through = source.pipeThrough({ readable: transform.readable, writable: transform.writable });
    console.log("pipeThroughPair", (await drain(through)).join(","));
  }

  // Anything that is not a transform or a readable/writable pair is refused.
  for (const bad of [5, "x", true, Symbol("s"), () => {}, [], undefined, null, {}]) {
    try {
      new ReadableStream().pipeThrough(bad);
      console.log("badThrough", typeof bad, "accepted");
    } catch (e) {
      console.log("badThrough", typeof bad, describe(e));
    }
  }

  // A locked source refuses pipeThrough.
  {
    const source = new ReadableStream();
    source.getReader();
    try {
      source.pipeThrough(new TransformStream());
      console.log("throughLocked", "accepted");
    } catch (e) {
      console.log("throughLocked", describe(e));
    }
  }

  // The transform's own error reaches the pipe's reader.
  {
    const boom = new Error("transform-boom");
    const source = new ReadableStream({ start(c) { c.enqueue(1); c.close(); } });
    const transform = new TransformStream({ transform() { throw boom; } });
    try {
      await drain(source.pipeThrough(transform));
      console.log("pipeThroughError", "resolved");
    } catch (e) {
      console.log("pipeThroughError", e === boom);
    }
  }
}

void main();
