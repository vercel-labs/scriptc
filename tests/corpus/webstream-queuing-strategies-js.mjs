import { CountQueuingStrategy as ImportedCount, ByteLengthQueuingStrategy as ImportedBytes } from "node:stream/web";

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

async function main() {
  // CountQueuingStrategy counts one per chunk, whatever the chunk.
  {
    const strategy = new CountQueuingStrategy({ highWaterMark: 3 });
    console.log("count", strategy.highWaterMark, strategy.size("anything"), strategy.size(2), strategy.size(), typeof strategy.size);
    console.log("count-type", strategy instanceof CountQueuingStrategy, Object.prototype.toString.call(strategy));
  }

  // ByteLengthQueuingStrategy sizes a chunk by its byteLength.
  {
    const strategy = new ByteLengthQueuingStrategy({ highWaterMark: 16 });
    console.log(
      "bytes",
      strategy.highWaterMark,
      strategy.size(new Uint8Array(5)),
      strategy.size(new DataView(new ArrayBuffer(9))),
      strategy.size("abc"),
      strategy.size(7),
    );
    console.log("bytes-type", strategy instanceof ByteLengthQueuingStrategy, strategy instanceof CountQueuingStrategy, Object.prototype.toString.call(strategy));
  }

  // The strategy's high-water mark reaches the controller's desiredSize, and
  // its size algorithm the queued total.
  {
    const events = [];
    const stream = new ReadableStream(
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
      { highWaterMark: 5, size(chunk) { return chunk * 2; } },
    );
    const reader = stream.getReader();
    console.log("sized-first", (await reader.read()).value, events.join(","));
    console.log("sized-done", (await reader.read()).done, events.join(","));
  }

  // A count strategy holds the source back while the queue is full, and pull
  // runs once a read makes room.
  {
    const events = [];
    const stream = new ReadableStream(
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
    await new Promise((resolve) => setTimeout(resolve, 5));
    const early = events.length;
    const first = await reader.read();
    const second = await reader.read();
    const third = await reader.read();
    console.log("backpressure", early, first.value, second.value, third.value, (await reader.read()).done);
    console.log("backpressure-events", events.join(","));
  }

  // A writable strategy sizes what the sink has not taken yet.
  {
    const written = [];
    const stream = new WritableStream(
      { write(chunk) { written.push(chunk.byteLength); } },
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

  // A transform stream takes a strategy for each side.
  {
    const transform = new TransformStream(
      { transform(chunk, controller) { controller.enqueue(chunk + 1); } },
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
    const stream = new ReadableStream({
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
      strategy.size(undefined);
      console.log("byte-undefined", "accepted");
    } catch (e) {
      console.log("byte-undefined", describe(e));
    }
    const stream = new WritableStream({ write() {} }, strategy);
    const writer = stream.getWriter();
    console.log("byte-write", await settle(writer.write(undefined)));
  }

  // An unusable init keeps Node's code and message.
  {
    for (const [label, make] of [
      ["no-init", () => new CountQueuingStrategy()],
      ["array-init", () => new CountQueuingStrategy([])],
      ["function-init", () => new ByteLengthQueuingStrategy(() => {})],
      ["string-init", () => new CountQueuingStrategy("x")],
      ["number-init", () => new ByteLengthQueuingStrategy(5)],
      ["null-init", () => new CountQueuingStrategy(null)],
      ["missing-hwm", () => new ByteLengthQueuingStrategy({})],
      ["undefined-hwm", () => new CountQueuingStrategy({ highWaterMark: undefined })],
      ["bigint-hwm", () => new CountQueuingStrategy({ highWaterMark: 1n })],
      ["throwing-hwm", () => new CountQueuingStrategy({ get highWaterMark() { throw new RangeError("hwm"); } })],
    ]) {
      try {
        const strategy = make();
        console.log(label, "accepted", strategy.highWaterMark);
      } catch (e) {
        console.log(label, describe(e));
      }
    }
  }

  // highWaterMark converts as Node converts it, so an odd value still
  // produces a strategy.
  {
    console.log("string-hwm", new CountQueuingStrategy({ highWaterMark: "7" }).highWaterMark);
    console.log("nan-hwm", new CountQueuingStrategy({ highWaterMark: {} }).highWaterMark);
    console.log("infinity-hwm", new ByteLengthQueuingStrategy({ highWaterMark: Infinity }).highWaterMark);
    console.log("negative-hwm", new ByteLengthQueuingStrategy({ highWaterMark: -1 }).highWaterMark);
  }

  // A size the stream refuses keeps Node's code and message, and one that
  // throws fails the construction.
  {
    try {
      new ReadableStream({ start(c) { c.enqueue(1); } }, { highWaterMark: 2, size: () => NaN });
      console.log("nan-size", "accepted");
    } catch (e) {
      console.log("nan-size", describe(e));
    }
    try {
      new ReadableStream({ start(c) { c.enqueue(1); } }, { highWaterMark: 2, size: () => "2" });
      const reader = new ReadableStream({ start() {}, pull() {} }, { highWaterMark: 2, size: () => "2" }).getReader();
      reader.releaseLock();
      console.log("string-size", "accepted");
    } catch (e) {
      console.log("string-size", describe(e));
    }
    try {
      new ReadableStream({ start(c) { c.enqueue(1); } }, { highWaterMark: 2, size: 5 });
      console.log("non-function-size", "accepted");
    } catch (e) {
      console.log("non-function-size", describe(e));
    }
    try {
      new ReadableStream(
        { start(c) { c.enqueue(1); } },
        { highWaterMark: 2, size() { throw new RangeError("size-boom"); } },
      );
      console.log("throwing-size", "accepted");
    } catch (e) {
      console.log("throwing-size", describe(e));
    }
    try {
      new ReadableStream({ start(c) { c.enqueue(1); } }, 5);
      console.log("number-strategy", "accepted");
    } catch (e) {
      console.log("number-strategy", describe(e));
    }
  }

  // The strategies from node:stream/web are the globals.
  {
    console.log("imported", ImportedCount === CountQueuingStrategy, ImportedBytes === ByteLengthQueuingStrategy);
    const strategy = new ImportedCount({ highWaterMark: 2 });
    const stream = new ReadableStream({ start(c) { c.enqueue(1); } }, strategy);
    console.log("imported-read", (await stream.getReader().read()).value, strategy.size("x"));
  }
}

void main();
