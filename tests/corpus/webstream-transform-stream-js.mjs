async function drain(r) {
  const out = [];
  for (;;) {
    const { done, value } = await r.read();
    if (done) return out;
    out.push(value);
  }
}

function describe(e) {
  if (typeof e === "string") return `string:${e}`;
  return `${e && e.code}:${e && e.message}:${Object.prototype.toString.call(e)}`;
}

function settle(p) {
  return p.then(
    () => "resolved",
    (e) => `rejected:${describe(e)}`,
  );
}

async function main() {
  // start, transform and flush, each holding the controller.
  {
    const log = [];
    const t = new TransformStream({
      start(c) { log.push(`start:${c.desiredSize}`); },
      transform(chunk, c) { log.push(`x:${chunk}:${c.desiredSize}`); c.enqueue(`v${chunk}`); return "ignored"; },
      flush(c) { log.push("flush"); c.enqueue("end"); },
    });
    const w = t.writable.getWriter();
    const reading = drain(t.readable.getReader());
    await w.write(1);
    await w.write(2);
    await w.close();
    console.log("transform", log.join(" "), (await reading).join(","));
  }

  // The identity transform passes values through unchanged.
  {
    const t = new TransformStream();
    const w = t.writable.getWriter();
    const r = t.readable.getReader();
    const first = r.read();
    await w.write(7);
    const got = await first;
    await w.close();
    console.log("identity", got.done, got.value, (await r.read()).done);
  }

  // Shape checks.
  {
    const t = new TransformStream();
    console.log("shape", t instanceof TransformStream, t.readable instanceof ReadableStream, t.writable instanceof WritableStream);
    console.log("tag", Object.prototype.toString.call(t));
    console.log("stable", t.readable === t.readable, t.writable === t.writable);
    console.log("locked", t.readable.locked, t.writable.locked);
    console.log("empty-ok", typeof new TransformStream({}).readable);
    console.log("undefined-ok", typeof new TransformStream(undefined).writable);
  }

  // The controller's own constructor is illegal.
  try {
    new TransformStreamDefaultController();
    console.log("controller-construct", "constructed");
  } catch (e) {
    console.log("controller-construct", describe(e));
  }

  // Invalid transformer arguments and members.
  try {
    const t = new TransformStream({ transform: 5 });
    console.log("invalid transform", "constructed", t.writable.locked);
  } catch (e) {
    console.log("invalid transform", describe(e));
  }
  try {
    const t = new TransformStream({ start: 5 });
    console.log("invalid start", "constructed", t.writable.locked);
  } catch (e) {
    console.log("invalid start", describe(e));
  }
  try {
    const t = new TransformStream({ flush: "x" });
    console.log("invalid flush", "constructed", t.writable.locked);
  } catch (e) {
    console.log("invalid flush", describe(e));
  }
  for (const transformer of [null, 5, "transformer"]) {
    try {
      const t = new TransformStream(transformer);
      console.log("invalid argument", typeof transformer, "constructed", t.writable.locked);
    } catch (e) {
      console.log("invalid argument", typeof transformer, describe(e));
    }
  }

  // Invalid strategies.
  try {
    new TransformStream({}, { highWaterMark: -1 });
    console.log("strategy writable-neg", "constructed");
  } catch (e) {
    console.log("strategy writable-neg", describe(e));
  }
  try {
    new TransformStream({}, { highWaterMark: "x" });
    console.log("strategy writable-string", "constructed");
  } catch (e) {
    console.log("strategy writable-string", describe(e));
  }
  try {
    new TransformStream({}, undefined, { highWaterMark: -1 });
    console.log("strategy readable-neg", "constructed");
  } catch (e) {
    console.log("strategy readable-neg", describe(e));
  }
  try {
    new TransformStream({}, undefined, { highWaterMark: Infinity });
    console.log("strategy readable-infinity", "constructed");
  } catch (e) {
    console.log("strategy readable-infinity", describe(e));
  }
  try {
    new TransformStream({}, undefined, null);
    console.log("strategy readable-null", "constructed");
  } catch (e) {
    console.log("strategy readable-null", describe(e));
  }

  // A method from the prototype refuses a foreign receiver.
  try {
    new TransformStream().readable.getReader.call(5);
    console.log("brand", "accepted");
  } catch (e) {
    console.log("brand", describe(e));
  }

  // A transform that throws errors both sides with that error.
  {
    const boom = new Error("transform-boom");
    const t = new TransformStream({ transform() { throw boom; } });
    const w = t.writable.getWriter();
    const r = t.readable.getReader();
    const closed = settle(w.closed);
    const written = w.write(1).then(() => "resolved", (e) => (e === boom ? "same" : "other"));
    try {
      await r.read();
      console.log("throw-read", "resolved");
    } catch (e) {
      console.log("throw-read", e === boom);
    }
    console.log("throw-write", await written);
    console.log("throw-closed", await closed);
  }

  // A rejected transform errors both sides too.
  {
    const t = new TransformStream({ transform() { return Promise.reject(new RangeError("rejected")); } });
    const w = t.writable.getWriter();
    const r = t.readable.getReader();
    const closed = settle(w.closed);
    const written = settle(w.write(1));
    console.log("reject-read", await settle(r.read()));
    console.log("reject-write", await written);
    console.log("reject-closed", await closed);
  }

  // A flush that throws lets the queued chunks out, then errors the reader.
  {
    const t = new TransformStream({ flush() { throw new RangeError("flush-boom"); } });
    const w = t.writable.getWriter();
    const r = t.readable.getReader();
    const first = r.read();
    await w.write(1);
    console.log("flush-close", await settle(w.close()));
    console.log("flush-first", JSON.stringify(await first));
    console.log("flush-read", await settle(r.read()));
  }

  // A start that throws rejects the construction itself.
  try {
    new TransformStream({ start() { throw new RangeError("start-boom"); } });
    console.log("start", "constructed");
  } catch (e) {
    console.log("start", describe(e));
  }

  // Controller error: both sides carry the same value, and enqueue refuses.
  {
    const boom = new TypeError("controller-error");
    let ctl;
    const t = new TransformStream({ start(c) { ctl = c; } });
    const w = t.writable.getWriter();
    const r = t.readable.getReader();
    const closed = settle(w.closed);
    const written = w.write(1).then(() => "resolved", (e) => (e === boom ? "same" : "other"));
    ctl.error(boom);
    try {
      await r.read();
      console.log("error-read", "resolved");
    } catch (e) {
      console.log("error-read", e === boom);
    }
    console.log("error-write", await written);
    console.log("error-closed", await closed);
    try {
      ctl.enqueue(9);
    } catch (e) {
      console.log("error-enqueue", describe(e));
    }
    console.log("error-desired", ctl.desiredSize);
  }

  // terminate ends the readable and errors the writable.
  {
    let ctl;
    const t = new TransformStream({ start(c) { ctl = c; } });
    const w = t.writable.getWriter();
    const r = t.readable.getReader();
    const closed = settle(w.closed);
    const written = settle(w.write(1));
    ctl.terminate();
    console.log("terminate-read", JSON.stringify(await r.read()));
    console.log("terminate-write", await written);
    console.log("terminate-closed", await closed);
    try {
      ctl.enqueue(1);
    } catch (e) {
      console.log("terminate-enqueue", describe(e));
    }
    console.log("terminate-desired", ctl.desiredSize);
  }

  // Cancelling the readable aborts the writable with the same reason.
  {
    const log = [];
    const t = new TransformStream({ transform(chunk, c) { log.push(`t:${chunk}`); c.enqueue(chunk); }, flush() { log.push("flush"); } });
    const w = t.writable.getWriter();
    const r = t.readable.getReader();
    const closed = settle(w.closed);
    const first = r.read();
    void w.write(1);
    console.log("cancel-first", JSON.stringify(await first));
    console.log("cancel", await settle(r.cancel("bye")));
    console.log("cancel-closed", await closed);
    console.log("cancel-log", log.join(","));
    console.log("cancel-write", await settle(w.write(2)));
  }

  // Aborting the writable errors the readable.
  {
    const t = new TransformStream();
    const w = t.writable.getWriter();
    const r = t.readable.getReader();
    console.log("abort", await settle(w.abort("stop")));
    console.log("abort-read", await settle(r.read()));
    console.log("abort-read-again", await settle(r.read()));
  }

  // Enqueue after the transform closed its readable is refused.
  {
    let ctl;
    const t = new TransformStream({ start(c) { ctl = c; } });
    const w = t.writable.getWriter();
    const r = t.readable.getReader();
    const first = r.read();
    await w.write(1);
    await w.close();
    console.log("late", JSON.stringify(await first), JSON.stringify(await r.read()));
    try {
      ctl.enqueue(9);
    } catch (e) {
      console.log("late-enqueue", describe(e));
    }
    console.log("late-desired", ctl.desiredSize);
  }

  // An async transform keeps the chunks in order, then flush runs.
  {
    const order = [];
    const t = new TransformStream({
      async transform(chunk, c) { await null; order.push(`t${chunk}`); c.enqueue(chunk * 2); },
      flush() { order.push("flush"); },
    });
    const w = t.writable.getWriter();
    const reading = drain(t.readable.getReader());
    await w.write(1);
    await w.write(2);
    await w.write(3);
    await w.close();
    console.log("async", order.join(","), (await reading).join(","));
  }

  // An async start finishes before the first chunk arrives.
  {
    const log = [];
    const t = new TransformStream({
      async start(c) { log.push("begin"); await null; log.push("end"); c.enqueue("first"); },
      transform(chunk, c) { log.push(`t${chunk}`); c.enqueue(chunk); },
    });
    const w = t.writable.getWriter();
    const reading = drain(t.readable.getReader());
    log.push("constructed");
    await w.write(1);
    await w.close();
    console.log("async-start", log.join(","), (await reading).join(","));
  }

  // An enqueued undefined chunk is a value, not the end of the stream.
  {
    const t = new TransformStream({ transform(chunk, c) { c.enqueue(chunk); } });
    const w = t.writable.getWriter();
    const r = t.readable.getReader();
    const first = r.read();
    await w.write(undefined);
    await w.close();
    const got = await first;
    console.log("undefined-chunk", got.done, "value" in got, got.value === undefined);
    console.log("undefined-end", (await r.read()).done);
  }

  // Writing after close and closing twice.
  {
    const t = new TransformStream();
    const w = t.writable.getWriter();
    const r = t.readable.getReader();
    const first = r.read();
    await w.write(1);
    await w.close();
    void first;
    console.log("closed", await settle(w.write(2)));
    console.log("closed-again", await settle(w.close()));
    console.log("closed-locked", t.readable.locked, t.writable.locked);
    console.log("closed-desired", w.desiredSize);
  }

  // The async iterator's results enumerate value before done, and its
  // completion result done before value.
  {
    const rs = new ReadableStream({ start(c) { c.enqueue("i"); c.close(); } });
    const it = rs.values();
    const ic = await it.next();
    console.log("iter-keys", JSON.stringify(Object.keys(ic)), JSON.stringify(ic));
    const id = await it.next();
    console.log("iter-done-keys", JSON.stringify(Object.keys(id)), JSON.stringify(id));
  }
}

void main();
