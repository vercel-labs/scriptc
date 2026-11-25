// The byte-stream half of the web streams in a JavaScript source: a
// ReadableStream constructed with a byte source, its default reader,
// autoAllocateChunkSize, and the refusals.
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

function refuse(label, fn) {
  try {
    fn();
    console.log(label, "no-throw");
  } catch (e) {
    console.log(label, describe(e));
  }
}

async function main() {
  // enqueue copies the chunk; the default reader gets the copy.
  {
    const chunk = new Uint8Array([1, 2, 3]);
    const stream = new ReadableStream({
      type: "bytes",
      start(c) {
        c.enqueue(chunk);
        c.close();
      },
    });
    const reader = stream.getReader();
    const first = await reader.read();
    console.log("copy", first.value, first.value.constructor.name, reader instanceof ReadableStreamDefaultReader);
    const end = await reader.read();
    console.log("end", end.done, end.value);
  }

  // The queue is measured in bytes; the default high water mark is zero.
  {
    const sizes = [];
    const stream = new ReadableStream({
      type: "bytes",
      start(c) {
        sizes.push(c.desiredSize);
        c.enqueue(new Uint8Array(5));
        sizes.push(c.desiredSize);
        c.close();
        sizes.push(c.desiredSize);
      },
    });
    const reader = stream.getReader();
    console.log("desired", sizes.join(","), reader.constructor.name);
    reader.releaseLock();
    await stream.cancel();
  }

  // autoAllocateChunkSize: the default read hands pull a BYOB view.
  {
    let step = 0;
    const stream = new ReadableStream({
      type: "bytes",
      autoAllocateChunkSize: 4,
      pull(c) {
        const request = c.byobRequest;
        if (request === null) return;
        step++;
        request.view.set([step, step + 10]);
        request.respond(2);
        if (step === 2) c.close();
      },
    });
    const reader = stream.getReader();
    const first = await reader.read();
    const second = await reader.read();
    const end = await reader.read();
    console.log("auto", first.value, first.done, second.value, second.done, end.done);
  }

  // enqueue in a pull-only source, driven by the default reader.
  {
    let pulls = 0;
    const stream = new ReadableStream({
      type: "bytes",
      pull(c) {
        pulls++;
        c.enqueue(new Uint8Array([pulls]));
        if (pulls === 2) c.close();
      },
    });
    const reader = stream.getReader();
    const a = await reader.read();
    const b = await reader.read();
    const end = await reader.read();
    console.log("pull", a.value, b.value, end.done, pulls);
  }

  // An error reaches a waiting default read as the same value.
  {
    const stream = new ReadableStream({
      type: "bytes",
      start(c) {
        c.enqueue(new Uint8Array([1]));
        c.error(new Error("boom"));
      },
    });
    const reader = stream.getReader();
    console.log("error queued", await settle(reader.read()));
    console.log("error next", await settle(reader.read()));
  }

  // enqueue refuses a zero-length chunk and a non-buffer value; the
  // source stays usable.
  {
    const log = [];
    const stream = new ReadableStream({
      type: "bytes",
      pull(c) {
        for (const value of [new Uint8Array(0), "ab", 7]) {
          try {
            c.enqueue(value);
            log.push("no-throw");
          } catch (e) {
            log.push(describe(e));
          }
        }
        c.enqueue(new Uint8Array([1]));
        c.close();
      },
    });
    const reader = stream.getReader();
    const first = await reader.read();
    console.log("enqueue-refused", log.join(" "), first.value);
  }

  // Constructor refusals.
  refuse("auto-zero", () => new ReadableStream({ type: "bytes", autoAllocateChunkSize: 0 }));
  refuse(
    "byob-reader-default",
    () => new ReadableStream({ start() {} }).getReader({ mode: "byob" }),
  );
  refuse("byob-reader-class", () => new ReadableStreamBYOBReader(new ReadableStream({ start() {} })));
  refuse("byob-reader-none", () => new ReadableStreamBYOBReader());
  refuse("controller-class", () => new ReadableByteStreamController());
  refuse("request-class", () => new ReadableStreamBYOBRequest());
}

main();
