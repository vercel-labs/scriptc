// ReadableByteStreamController: enqueue, close, error and desiredSize, and
// the BYOB reader's read, cancel, releaseLock and closed.
function describe(error: unknown): string {
  if (typeof error === "string") return error;
  const err = error as { code?: string; message?: string };
  return `${err.code}:${err.message}`;
}

async function settle(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => "resolved",
    (error: unknown) => `rejected:${describe(error)}`,
  );
}

async function main(): Promise<void> {
  {
    // enqueue counts against desiredSize; close ends the stream.
    const stream = new ReadableStream({
      type: "bytes",
      start(controller: ReadableByteStreamController) {
        console.log("controller class", controller instanceof ReadableByteStreamController);
        console.log("desired", controller.desiredSize);
        controller.enqueue(new Uint8Array([1, 2]));
        console.log("after enqueue", controller.desiredSize);
        controller.close();
      },
    });
    const reader = stream.getReader({ mode: "byob" });
    const first = await reader.read(new Uint8Array(2));
    console.log("chunk", first.value instanceof Uint8Array, first.done);
    const end = await reader.read(new Uint8Array(2));
    console.log("end", end.done);
    console.log("closed", await settle(reader.closed));
  }

  {
    // An error rejects the pending read and the reader's closed.
    const stream = new ReadableStream({
      type: "bytes",
      start(controller: ReadableByteStreamController) {
        controller.error(new RangeError("bad byte stream"));
      },
    });
    const reader = stream.getReader({ mode: "byob" });
    console.log("read", await settle(reader.read(new Uint8Array(1))));
    console.log("reader closed", await settle(reader.closed));
  }

  {
    // cancel settles the reader's closed.
    const stream = new ReadableStream({
      type: "bytes",
      pull() {},
    });
    const reader = stream.getReader({ mode: "byob" });
    await reader.cancel("stop");
    console.log("cancelled", await settle(reader.closed), stream.locked);
  }

  {
    // The request a pending BYOB read creates answers the caller's view.
    const stream = new ReadableStream({
      type: "bytes",
      pull(controller: ReadableByteStreamController) {
        const request = controller.byobRequest;
        console.log("request class", request instanceof ReadableStreamBYOBRequest);
        if (request === null || request.view === null) return;
        (request.view as Uint8Array).set([7]);
        request.respond(1);
        controller.close();
      },
    });
    const reader = stream.getReader({ mode: "byob" });
    console.log("reader class", reader instanceof ReadableStreamBYOBReader);
    const first = await reader.read(new Uint8Array(1));
    console.log("request read", (first.value as Uint8Array)[0], first.done);
    const requestEnd = await reader.read(new Uint8Array(1));
    console.log("request end", requestEnd.done);
  }

  {
    // releaseLock without a pending read resolves closed on the next turn.
    const stream = new ReadableStream({
      type: "bytes",
      pull() {},
    });
    const reader = stream.getReader({ mode: "byob" });
    console.log("locked", stream.locked);
    reader.releaseLock();
    console.log("released", stream.locked, await settle(reader.closed));
  }
}

await main();
