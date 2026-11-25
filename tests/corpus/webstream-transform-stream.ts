async function drain(r: ReadableStreamDefaultReader<string>): Promise<string[]> {
  const out: string[] = [];
  for (;;) {
    const { done, value } = await r.read();
    if (done) return out;
    out.push(value);
  }
}

function describe(e: unknown): string {
  if (typeof e === "string") return `string:${e}`;
  const err = e as { code?: string; message?: string };
  return `${err.code}:${err.message}:${Object.prototype.toString.call(e)}`;
}

function settle(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => "resolved",
    (e) => `rejected:${describe(e)}`,
  );
}

async function main(): Promise<void> {
  // start, transform and flush, each holding the controller.
  {
    const log: string[] = [];
    const t = new TransformStream<number, string>({
      start(c) {
        log.push(`start:${c.desiredSize}`);
      },
      transform(chunk, c) {
        log.push(`x:${chunk}:${c.desiredSize}`);
        c.enqueue(`v${chunk}`);
      },
      flush(c) {
        log.push("flush");
        c.enqueue("end");
      },
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
    const t = new TransformStream<number, number>();
    const w = t.writable.getWriter();
    const r = t.readable.getReader();
    const first = r.read();
    await w.write(7);
    const got = await first;
    await w.close();
    const end = await r.read();
    console.log("identity", got.done, got.value, end.done);
  }

  // The controller's own constructor is illegal.
  try {
    const c = new TransformStreamDefaultController();
    void c;
    console.log("controller-construct", "constructed");
  } catch (e) {
    console.log("controller-construct", describe(e));
  }

  // A readable strategy's high-water mark reaches the controller's desiredSize.
  {
    const t = new TransformStream<number, number>(
      {
        transform(chunk, c) {
          c.enqueue(chunk);
          console.log("desired", chunk, c.desiredSize);
        },
      },
      undefined,
      { highWaterMark: 2 },
    );
    const w = t.writable.getWriter();
    const reading = (async () => {
      const r = t.readable.getReader();
      const values: number[] = [];
      for (;;) {
        const { done, value } = await r.read();
        if (done) return values;
        values.push(value);
      }
    })();
    await w.write(1);
    await w.write(2);
    await w.write(3);
    await w.close();
    console.log("strategy", (await reading).join(","));
  }

  // A transform that throws errors both sides with that error.
  {
    const boom = new Error("transform-boom");
    const t = new TransformStream<number, number>({
      transform() {
        throw boom;
      },
    });
    const w = t.writable.getWriter();
    const r = t.readable.getReader();
    const closed = settle(w.closed);
    const written = w.write(1).then(
      () => "resolved",
      (e) => (e === boom ? "same" : "other"),
    );
    try {
      await r.read();
      console.log("transform-throw-read", "resolved");
    } catch (e) {
      console.log("transform-throw-read", e === boom);
    }
    console.log("transform-throw-write", await written);
    console.log("transform-throw-closed", await closed);
  }

  // A flush that throws lets the queued chunks out, then errors the reader.
  {
    const t = new TransformStream<number, number>({
      flush() {
        throw new RangeError("flush-boom");
      },
    });
    const w = t.writable.getWriter();
    const r = t.readable.getReader();
    const first = r.read();
    await w.write(1);
    console.log("flush-close", await settle(w.close()));
    const got = await first;
    console.log("flush-first", got.done, got.value);
    try {
      await r.read();
      console.log("flush-read", "resolved");
    } catch (e) {
      console.log("flush-read", describe(e));
    }
  }

  // A start that throws rejects the construction itself.
  try {
    const t = new TransformStream<number, number>({
      start() {
        throw new RangeError("start-boom");
      },
    });
    void t;
    console.log("start", "constructed");
  } catch (e) {
    console.log("start", describe(e));
  }

  // Controller error: both sides carry the same value, and enqueue refuses.
  {
    const boom = new TypeError("controller-error");
    let ctl: TransformStreamDefaultController<number> | undefined;
    const t = new TransformStream<number, number>({
      start(c) {
        ctl = c;
      },
    });
    const w = t.writable.getWriter();
    const r = t.readable.getReader();
    const closed = settle(w.closed);
    const written = w.write(1).then(
      () => "resolved",
      (e) => (e === boom ? "same" : "other"),
    );
    ctl!.error(boom);
    try {
      await r.read();
      console.log("error-read", "resolved");
    } catch (e) {
      console.log("error-read", e === boom);
    }
    console.log("error-write", await written);
    console.log("error-closed", await closed);
    try {
      ctl!.enqueue(9);
    } catch (e) {
      console.log("error-enqueue", describe(e));
    }
    console.log("error-desired", ctl!.desiredSize);
  }

  // terminate ends the readable and errors the writable.
  {
    let ctl: TransformStreamDefaultController<number> | undefined;
    const t = new TransformStream<number, number>({
      start(c) {
        ctl = c;
      },
    });
    const w = t.writable.getWriter();
    const r = t.readable.getReader();
    const closed = settle(w.closed);
    const written = settle(w.write(1));
    ctl!.terminate();
    const end = await r.read();
    console.log("terminate-read", end.done, end.value);
    console.log("terminate-write", await written);
    console.log("terminate-closed", await closed);
    try {
      ctl!.enqueue(1);
    } catch (e) {
      console.log("terminate-enqueue", describe(e));
    }
    console.log("terminate-desired", ctl!.desiredSize);
  }

  // Cancelling the readable aborts the writable with the same reason.
  {
    const log: string[] = [];
    const t = new TransformStream<number, number>({
      transform(chunk, c) {
        log.push(`t:${chunk}`);
        c.enqueue(chunk);
      },
      flush() {
        log.push("flush");
      },
    });
    const w = t.writable.getWriter();
    const r = t.readable.getReader();
    const closed = settle(w.closed);
    const first = r.read();
    void w.write(1);
    const got = await first;
    console.log("cancel-first", got.done, got.value);
    console.log("cancel", await settle(r.cancel("bye")));
    console.log("cancel-closed", await closed);
    console.log("cancel-log", log.join(","));
    console.log("cancel-write", await settle(w.write(2)));
  }

  // Aborting the writable errors the readable.
  {
    const t = new TransformStream<number, number>();
    const w = t.writable.getWriter();
    const r = t.readable.getReader();
    console.log("abort", await settle(w.abort("stop")));
    try {
      await r.read();
      console.log("abort-read", "resolved");
    } catch (e) {
      console.log("abort-read", describe(e));
    }
    try {
      await r.read();
      console.log("abort-read-again", "resolved");
    } catch (e) {
      console.log("abort-read-again", describe(e));
    }
  }

  // Enqueue after the transform closed its readable is refused.
  {
    let ctl: TransformStreamDefaultController<number> | undefined;
    const t = new TransformStream<number, number>({
      start(c) {
        ctl = c;
      },
    });
    const w = t.writable.getWriter();
    const r = t.readable.getReader();
    const first = r.read();
    await w.write(1);
    await w.close();
    const got = await first;
    const end = await r.read();
    console.log("late", got.done, got.value, end.done);
    try {
      ctl!.enqueue(9);
    } catch (e) {
      console.log("late-enqueue", describe(e));
    }
    console.log("late-desired", ctl!.desiredSize);
  }

  // An async transform keeps the chunks in order, then flush runs.
  {
    const order: string[] = [];
    const t = new TransformStream<number, number>({
      async transform(chunk, c) {
        await Promise.resolve();
        order.push(`t${chunk}`);
        c.enqueue(chunk * 2);
      },
      flush() {
        order.push("flush");
      },
    });
    const w = t.writable.getWriter();
    const r = t.readable.getReader();
    const out: number[] = [];
    const reading = (async () => {
      for (;;) {
        const { done, value } = await r.read();
        if (done) return out;
        out.push(value);
      }
    })();
    await w.write(1);
    await w.write(2);
    await w.write(3);
    await w.close();
    console.log("async", order.join(","), (await reading).join(","));
  }

  // An enqueued undefined chunk is a value, not the end of the stream.
  {
    const t = new TransformStream<number, string | undefined>({
      transform(chunk, c) {
        c.enqueue(undefined);
        void chunk;
      },
    });
    const w = t.writable.getWriter();
    const r = t.readable.getReader();
    const first = r.read();
    await w.write(1);
    await w.close();
    const got = await first;
    console.log("undefined-chunk", got.done, got.value === undefined);
    const end = await r.read();
    console.log("undefined-end", end.done);
  }

  // Writing after close and closing twice.
  {
    const t = new TransformStream<number, number>();
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
}

void main();
