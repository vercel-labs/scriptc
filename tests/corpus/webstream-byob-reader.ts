// ReadableStreamBYOBReader: reads into caller views, the byobRequest
// lifecycle, respond/respondWithNewView, and the refusals.
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
  // The request's view is the caller's window; respond says how much is
  // filled, and the read answers a view of that length.
  {
    let viewLength = -1;
    const stream = new ReadableStream({
      type: "bytes",
      pull(c: ReadableByteStreamController) {
        const request = c.byobRequest;
        if (request === null) return;
        const view = request.view;
        if (view === null) return;
        viewLength = view.byteLength;
        view.set([1, 2]);
        request.respond(2);
        c.close();
      },
    });
    const reader = stream.getReader({ mode: "byob" });
    const first = await reader.read(new Uint8Array(4));
    const end = await reader.read(new Uint8Array(4));
    console.log("view length", viewLength);
    console.log("byob", first.value, first.done, end.value, end.done);
  }

  // A read stops at the smaller of the view and the water mark; two reads
  // against one pull each answer fresh views.
  {
    let step = 0;
    const stream = new ReadableStream({
      type: "bytes",
      pull(c: ReadableByteStreamController) {
        const request = c.byobRequest;
        if (request === null) return;
        const view = request.view;
        if (view === null) return;
        step++;
        (view as Uint8Array).set([step, step + 10]);
        request.respond(2);
        if (step === 2) c.close();
      },
    });
    const reader = stream.getReader({ mode: "byob" });
    const first = await reader.read(new Uint8Array(4));
    const second = await reader.read(new Uint8Array(4));
    const end = await reader.read(new Uint8Array(4));
    console.log("split", first.value, second.value, end.done, step);
  }

  // min keeps a read pending until that many bytes arrive.
  {
    let step = 0;
    const stream = new ReadableStream({
      type: "bytes",
      pull(c: ReadableByteStreamController) {
        const request = c.byobRequest;
        if (request === null) return;
        const view = request.view;
        if (view === null) return;
        step++;
        (view as Uint8Array).set([step]);
        request.respond(1);
        if (step === 3) c.close();
      },
    });
    const reader = stream.getReader({ mode: "byob" });
    const result = await reader.read(new Uint8Array(8), { min: 2 });
    console.log("min", result.value, result.done, step);
    reader.releaseLock();
  }

  // The view keeps the caller's element type.
  {
    const stream = new ReadableStream({
      type: "bytes",
      pull(c: ReadableByteStreamController) {
        const request = c.byobRequest;
        if (request === null) return;
        const view = request.view;
        if (view === null) return;
        (view as Uint8Array).set([7, 0, 8, 0]);
        request.respond(4);
        c.close();
      },
    });
    const reader = stream.getReader({ mode: "byob" });
    const result = await reader.read(new Int16Array(2));
    const value = result.value;
    console.log(
      "int16",
      value,
      value === undefined || value === null ? "none" : value.constructor.name,
    );
  }

  // The request exists only while a read waits: null in start, and stale
  // after the respond that satisfies the read.
  {
    let inStart = "unset";
    const held: { request: ReadableStreamBYOBRequest | null } = { request: null };
    const stream = new ReadableStream({
      type: "bytes",
      start(c: ReadableByteStreamController) {
        inStart = c.byobRequest === null ? "null" : "present";
        c.enqueue(new Uint8Array([5]));
        c.close();
      },
      pull(c: ReadableByteStreamController) {
        held.request = c.byobRequest;
      },
    });
    const reader = stream.getReader();
    const first = await reader.read();
    console.log("start request", inStart, first.value, first.done);
  }
  {
    const held: { request: ReadableStreamBYOBRequest | null } = { request: null };
    const stream = new ReadableStream({
      type: "bytes",
      pull(c: ReadableByteStreamController) {
        const request = c.byobRequest;
        if (request === null) return;
        held.request = request;
        const view = request.view;
        if (view === null) return;
        (view as Uint8Array).set([1]);
        request.respond(1);
      },
    });
    const reader = stream.getReader({ mode: "byob" });
    const first = await reader.read(new Uint8Array(4));
    const request = held.request;
    console.log("first", first.value, first.done);
    if (request !== null) {
      console.log("stale view", request.view);
      try {
        request.respond(1);
        console.log("stale respond", "no-throw");
      } catch (e) {
        console.log("stale respond", describe(e));
      }
      try {
        request.respondWithNewView(new Uint8Array(1));
        console.log("stale newview", "no-throw");
      } catch (e) {
        console.log("stale newview", describe(e));
      }
    }
    reader.releaseLock();
    await stream.cancel();
  }

  // respond refuses zero, NaN and more than the view holds; the request
  // stays valid for the respond that satisfies the read.
  {
    const log: string[] = [];
    const stream = new ReadableStream({
      type: "bytes",
      pull(c: ReadableByteStreamController) {
        const request = c.byobRequest;
        if (request === null) return;
        const cases: (() => void)[] = [
          () => request.respond(0),
          () => request.respond(NaN),
          () => request.respond(99),
        ];
        for (const run of cases) {
          try {
            run();
            log.push("ok");
          } catch (e) {
            log.push(describe(e));
          }
        }
        const view = request.view;
        if (view !== null) (view as Uint8Array).set([3]);
        request.respond(1);
        c.close();
      },
    });
    const reader = stream.getReader({ mode: "byob" });
    const result = await reader.read(new Uint8Array(4));
    console.log("respond", log.join(" | "), result.value);
  }

  // respond coerces a numeric string and truncates a fraction.
  {
    const stream = new ReadableStream({
      type: "bytes",
      pull(c: ReadableByteStreamController) {
        const request = c.byobRequest;
        if (request === null) return;
        const view = request.view;
        if (view === null) return;
        (view as Uint8Array).set([4, 5, 6, 7]);
        request.respond("2" as unknown as number);
        c.close();
      },
    });
    const reader = stream.getReader({ mode: "byob" });
    const result = await reader.read(new Uint8Array(4));
    console.log("respond string", result.value);
  }

  // read refusals.
  {
    const stream = new ReadableStream({ type: "bytes" });
    const reader = stream.getReader({ mode: "byob" });
    const anyReader: any = reader;
    console.log("read no view", await settle(anyReader.read()));
    console.log("read array", await settle(anyReader.read([1, 2])));
    console.log("read string", await settle(anyReader.read("ab")));
    console.log("read zero", await settle(anyReader.read(new Uint8Array(0))));
    console.log("read min", await settle(anyReader.read(new Uint8Array(2), { min: 5 })));
    reader.releaseLock();
    await stream.cancel();
  }

  // A closed stream answers an empty view and done.
  {
    const stream = new ReadableStream({ type: "bytes" });
    await stream.cancel();
    const reader = stream.getReader({ mode: "byob" });
    const result = await reader.read(new Uint8Array(3));
    console.log("closed", result.value, result.done);
  }

  // A released reader refuses further reads.
  {
    const stream = new ReadableStream({
      type: "bytes",
      pull(c: ReadableByteStreamController) {
        c.close();
      },
    });
    const reader = stream.getReader({ mode: "byob" });
    reader.releaseLock();
    console.log("released", await settle(reader.read(new Uint8Array(2))));
  }

  // Reader and controller identity.
  {
    const stream = new ReadableStream({
      type: "bytes",
      start(c: ReadableByteStreamController) {
        console.log(
          "controller",
          c.constructor.name,
          c instanceof ReadableByteStreamController,
          "byobRequest" in c,
          c.desiredSize,
        );
      },
    });
    const reader = stream.getReader({ mode: "byob" });
    console.log(
      "reader",
      reader.constructor.name,
      reader instanceof ReadableStreamBYOBReader,
      "read" in reader,
      "releaseLock" in reader,
    );
    reader.releaseLock();
    await stream.cancel();
  }
}

main();
