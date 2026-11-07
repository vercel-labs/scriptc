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

async function main(): Promise<void> {
  // CountQueuingStrategy counts one per chunk, whatever the chunk.
  {
    const strategy = new CountQueuingStrategy({ highWaterMark: 3 });
    console.log(
      "count",
      strategy.highWaterMark,
      strategy.size("anything"),
      strategy.size(2),
      strategy.size(undefined),
      typeof strategy.size,
    );
  }

  // ByteLengthQueuingStrategy sizes a chunk by its byteLength.
  {
    const strategy = new ByteLengthQueuingStrategy({ highWaterMark: 16 });
    console.log(
      "bytes",
      strategy.highWaterMark,
      strategy.size(new Uint8Array(5)),
      strategy.size(new DataView(new ArrayBuffer(9))),
    );
  }

  // The strategy's high-water mark reaches the controller's desiredSize, and
  // its size algorithm the queued total.
  {
    const events: string[] = [];
    const stream = new ReadableStream<number>(
      {
        start(c) {
          events.push(`start:${c.desiredSize}`);
          c.enqueue(2);
          events.push(`after:${c.desiredSize}`);
        },
        pull(c) {
          events.push(`pull:${c.desiredSize}`);
          c.close();
        },
      },
      {
        highWaterMark: 5,
        size(chunk: number) {
          return chunk * 2;
        },
      },
    );
    const reader = stream.getReader();
    console.log("sized-first", (await reader.read()).value, events.join(","));
    console.log("sized-done", (await reader.read()).done, events.join(","));
  }

  // A count strategy holds the source back while the queue is full, and pull
  // runs once a read makes room.
  {
    const events: string[] = [];
    const stream = new ReadableStream<number>(
      {
        start(c) {
          c.enqueue(1);
          c.enqueue(2);
          c.enqueue(3);
        },
        pull(c) {
          events.push(`pull:${c.desiredSize}`);
          c.close();
        },
      },
      new CountQueuingStrategy({ highWaterMark: 1 }),
    );
    const reader = stream.getReader();
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    const early = events.length;
    const first = await reader.read();
    const second = await reader.read();
    const third = await reader.read();
    console.log("backpressure", early, first.value, second.value, third.value, (await reader.read()).done);
    console.log("backpressure-events", events.join(","));
  }

  // A writable strategy sizes what the sink has not taken yet.
  {
    const written: number[] = [];
    const stream = new WritableStream<Uint8Array>(
      {
        write(chunk) {
          written.push(chunk.byteLength);
        },
      },
      new ByteLengthQueuingStrategy({ highWaterMark: 10 }),
    );
    const writer = stream.getWriter();
    console.log("writer-start", writer.desiredSize);
    const pending = writer.write(new Uint8Array(4));
    console.log("writer-pending", writer.desiredSize);
    await pending;
    console.log("writer-done", writer.desiredSize, written.join(","));
    await writer.close();
  }

  // A strategy held as the QueuingStrategy interface reaches the constructor.
  {
    const strategy: QueuingStrategy<number> = {
      highWaterMark: 5,
      size(chunk: number) {
        return chunk * 2;
      },
    };
    const stream = new ReadableStream<number>(
      {
        start(c) {
          console.log("iface-desired", c.desiredSize);
          c.enqueue(2);
          console.log("iface-after", c.desiredSize);
        },
      },
      strategy,
    );
    const reader = stream.getReader();
    console.log("iface-read", (await reader.read()).value);
    console.log("iface-hwm", strategy.highWaterMark, typeof strategy.size);
  }

  // A transform stream takes a strategy for each side.
  {
    const transform = new TransformStream<number, number>(
      {
        transform(chunk, controller) {
          controller.enqueue(chunk + 1);
        },
      },
      new CountQueuingStrategy({ highWaterMark: 2 }),
      new CountQueuingStrategy({ highWaterMark: 4 }),
    );
    const writer = transform.writable.getWriter();
    console.log("transform-writer", writer.desiredSize);
    await writer.write(1);
    const reader = transform.readable.getReader();
    console.log("transform-read", (await reader.read()).value);
    await writer.close();
    console.log("transform-done", (await reader.read()).done);
  }

  // The default high-water mark is one when a stream has no strategy.
  {
    const stream = new ReadableStream<number>({
      start(c) {
        console.log("default-desired", c.desiredSize);
        c.enqueue(1);
        console.log("default-after", c.desiredSize);
      },
    });
    const reader = stream.getReader();
    console.log("default-read", (await reader.read()).value);
  }

  // The byte strategy reads byteLength as a property, so a chunk without one
  // throws where a write meets it.
  {
    const strategy = new ByteLengthQueuingStrategy({ highWaterMark: 4 });
    try {
      strategy.size(undefined as unknown as Uint8Array);
      console.log("byte-undefined", "accepted");
    } catch (e) {
      console.log("byte-undefined", describe(e));
    }
    console.log("byte-number", strategy.size(7 as unknown as Uint8Array));
    const stream = new WritableStream<Uint8Array>({ write() {} }, strategy);
    const writer = stream.getWriter();
    console.log("byte-write", await settle(writer.write(undefined as unknown as Uint8Array)));
  }

  // An unusable init is refused with Node's code and message.
  {
    try {
      new CountQueuingStrategy({ highWaterMark: undefined as unknown as number });
      console.log("missing-hwm", "accepted");
    } catch (e) {
      console.log("missing-hwm", describe(e));
    }
    try {
      new ByteLengthQueuingStrategy(5 as unknown as { highWaterMark: number });
      console.log("number-init", "accepted");
    } catch (e) {
      console.log("number-init", describe(e));
    }
    try {
      new CountQueuingStrategy(null as unknown as { highWaterMark: number });
      console.log("null-init", "accepted");
    } catch (e) {
      console.log("null-init", describe(e));
    }
    console.log("negative-hwm", new ByteLengthQueuingStrategy({ highWaterMark: -1 }).highWaterMark);
  }

  // A size the stream refuses keeps Node's code and message, and one that
  // throws fails the construction.
  {
    try {
      new ReadableStream<number>(
        {
          start(c) {
            c.enqueue(1);
          },
        },
        { highWaterMark: 2, size: () => NaN },
      );
      console.log("nan-size", "accepted");
    } catch (e) {
      console.log("nan-size", describe(e));
    }
    try {
      new WritableStream<number>({ write() {} }, { highWaterMark: 2, size: () => -1 });
      console.log("negative-size", "accepted");
    } catch (e) {
      console.log("negative-size", describe(e));
    }
    try {
      new ReadableStream<number>(
        {
          start(c) {
            c.enqueue(1);
          },
        },
        {
          highWaterMark: 2,
          size() {
            throw new RangeError("size-boom");
          },
        },
      );
      console.log("throwing-size", "accepted");
    } catch (e) {
      console.log("throwing-size", describe(e));
    }
  }
}

void main();
