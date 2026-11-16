// Byte streams: a web ReadableStream made from a "bytes" source fills BYOB
// views through its controller's byobRequest, and the BYOB reader, its
// request, and the byte controller answer Node's reads, state, and errors.
const log: string[] = [];

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorShape(label: string, fn: () => unknown): void {
  try {
    fn();
    log.push(`${label} no throw`);
  } catch (e: unknown) {
    const error = e as Error;
    log.push(`${label} ${e instanceof TypeError} ${error.name} ${(error as { code?: string }).code ?? "-"} ${error.message}`);
  }
}

async function main(): Promise<void> {
  // A source that answers each pull through a fresh BYOB request.
  const chunks = [[1, 2, 3], [4, 5], [6, 7, 8, 9]];
  let pullIndex = 0;
  const rs = new ReadableStream({
    type: "bytes",
    start(controller): void {
      log.push(`start byob ${controller.byobRequest} desired ${controller.desiredSize}`);
    },
    pull(controller): void {
      const request = controller.byobRequest;
      if (request === null) {
        log.push("pull without request");
        return;
      }
      const view = request.view as Uint8Array;
      log.push(`pull view ${view.byteLength} desired ${controller.desiredSize}`);
      const chunk = chunks[pullIndex];
      if (chunk === undefined) {
        log.push("pull beyond the scripted chunks");
        controller.close();
        return;
      }
      pullIndex++;
      if (view.byteLength <= chunk.length) {
        view.set(chunk.slice(0, view.byteLength));
        request.respond(view.byteLength);
        return;
      }
      view.set(chunk);
      request.respondWithNewView(view.subarray(0, chunk.length));
    },
    cancel(reason): void {
      log.push(`cancel ${String(reason)}`);
    },
  });
  log.push(`classes ${typeof ReadableStreamBYOBReader} ${typeof ReadableStreamBYOBRequest} ${typeof ReadableByteStreamController}`);
  log.push(`locked ${rs.locked}`);
  const reader = rs.getReader({ mode: "byob" });
  log.push(`byob reader ${reader instanceof ReadableStreamBYOBReader} locked ${rs.locked} closed ${reader.closed instanceof Promise}`);
  const first = await reader.read(new Uint8Array(8));
  log.push(`first ${first.done} ${first.value instanceof Uint8Array} ${Array.from(first.value as Uint8Array)}`);
  const second = await reader.read(new Uint8Array(2));
  log.push(`second ${second.done} ${Array.from(second.value as Uint8Array)}`);
  // The reader keeps the rest of the requested view when it detaches it.
  const third = await reader.read(new Uint8Array(16), { min: 2 });
  log.push(`third ${third.done} ${Array.from(third.value as Uint8Array)}`);
  reader.releaseLock();
  log.push(`released locked ${rs.locked}`);

  // An invalidated request refuses further answers.
  const requests: ReadableStreamBYOBRequest[] = [];
  const rs2 = new ReadableStream({
    type: "bytes",
    pull(controller): void {
      const request = controller.byobRequest;
      if (request === null) return;
      requests.push(request);
      request.respond(1);
      errorShape("respond twice", () => request.respond(1));
      errorShape("respondWithNewView after respond", () => request.respondWithNewView(new Uint8Array(1)));
      controller.close();
    },
  });
  const reader2 = rs2.getReader({ mode: "byob" });
  const end = await reader2.read(new Uint8Array(4));
  log.push(`closed read ${end.done} ${end.value === undefined}`);
  await reader2.closed;
  log.push(`closed resolved ${rs2.locked}`);
  reader2.releaseLock();

  // A byte controller enqueues views directly and refuses other chunks.
  // Its state errors name the controller once close was requested and the
  // stream once the stream itself closed.
  const rs3 = new ReadableStream({
    type: "bytes",
    start(controller): void {
      controller.enqueue(new Uint8Array([10, 11]));
      controller.enqueue(new Uint8Array([12]));
      controller.close();
      try {
        controller.close();
        log.push("close twice ok");
      } catch (e: unknown) {
        log.push(`close twice ${(e as Error).message}`);
      }
      try {
        controller.enqueue(new Uint8Array([1]));
        log.push("enqueue after close ok");
      } catch (e: unknown) {
        log.push(`enqueue after close ${(e as Error).message}`);
      }
    },
  });
  const rs3b = new ReadableStream({
    type: "bytes",
    start(controller): void {
      controller.close();
      try {
        controller.close();
        log.push("empty close twice ok");
      } catch (e: unknown) {
        log.push(`empty close twice ${(e as Error).message}`);
      }
      try {
        controller.enqueue(new Uint8Array([1]));
        log.push("empty enqueue after close ok");
      } catch (e: unknown) {
        log.push(`empty enqueue after close ${(e as Error).message}`);
      }
    },
  });
  await rs3b.getReader().read();
  const reader3 = rs3.getReader({ mode: "byob" });
  const a = await reader3.read(new Uint8Array(3));
  log.push(`enqueued ${Array.from(a.value as Uint8Array)}`);
  const b = await reader3.read(new Uint8Array(3));
  log.push(`enqueued rest ${Array.from(b.value as Uint8Array)}`);
  const c = await reader3.read(new Uint8Array(3));
  log.push(`enqueued end ${c.done}`);

  // autoAllocateChunkSize answers a default reader's byte read.
  const rs4 = new ReadableStream({
    type: "bytes",
    autoAllocateChunkSize: 4,
    pull(controller): void {
      const request = controller.byobRequest;
      if (request === null) return;
      const view = request.view as Uint8Array;
      view.set([20, 21]);
      request.respond(2);
    },
  });
  const reader4 = rs4.getReader();
  const auto = await reader4.read();
  log.push(`auto ${auto.done} ${Array.from(auto.value as Uint8Array)}`);
  await reader4.cancel("stop");
  const cancelled = await reader4.read();
  log.push(`cancelled read ${cancelled.done} ${cancelled.value === undefined}`);

  // Cancelling a BYOB reader with a parked read settles it as done.
  let cancelReason = "";
  const rs5 = new ReadableStream({
    type: "bytes",
    pull(): void {},
    cancel(reason): void {
      cancelReason = String(reason);
    },
  });
  const reader5 = rs5.getReader({ mode: "byob" });
  const parked = reader5.read(new Uint8Array(4));
  await reader5.cancel("bye");
  const parkedResult = await parked;
  log.push(`parked ${parkedResult.done} cancel ${cancelReason}`);
  reader5.releaseLock();
  log.push(`final locked ${rs5.locked}`);

  // error() rejects the parked read and the closed promise, and the
  // controller answers no more requests.
  const rs6 = new ReadableStream({
    type: "bytes",
    pull(controller): void {
      log.push(`error pull desired ${controller.desiredSize}`);
      controller.error(new Error("boom"));
      log.push(`errored desired ${controller.desiredSize} byob ${controller.byobRequest}`);
      try {
        controller.enqueue(new Uint8Array([1]));
        log.push("enqueue after error ok");
      } catch (e: unknown) {
        log.push(`enqueue after error ${(e as Error).message}`);
      }
      try {
        controller.close();
        log.push("close after error ok");
      } catch (e: unknown) {
        log.push(`close after error ${(e as Error).message}`);
      }
    },
  });
  const reader6 = rs6.getReader({ mode: "byob" });
  try {
    await reader6.read(new Uint8Array(2));
    log.push("error read resolved");
  } catch (e: unknown) {
    log.push(`error read rejected ${(e as Error).message}`);
  }
  try {
    await reader6.closed;
    log.push("error closed resolved");
  } catch (e: unknown) {
    log.push(`error closed rejected ${(e as Error).message}`);
  }
  reader6.releaseLock();

  // A close over a partially filled multi-byte read errors the stream and
  // throws the same error to the caller.
  let pendingController: ReadableByteStreamController | null = null;
  const rs7 = new ReadableStream({
    type: "bytes",
    pull(controller): void {
      pendingController = controller;
    },
  });
  const reader7 = rs7.getReader({ mode: "byob" });
  const partialRead = reader7.read(new Uint32Array(2));
  await wait(5);
  const pendingRequest = pendingController!.byobRequest;
  log.push(`partial request ${pendingRequest === null}`);
  pendingRequest!.respond(2);
  try {
    pendingController!.close();
    log.push("partial close ok");
  } catch (e: unknown) {
    log.push(`partial close ${(e as Error).message}`);
  }
  try {
    await partialRead;
    log.push("partial read resolved");
  } catch (e: unknown) {
    log.push(`partial read ${(e as Error).message}`);
  }
  try {
    await reader7.closed;
    log.push("partial closed resolved");
  } catch (e: unknown) {
    log.push(`partial closed rejected ${(e as Error).message}`);
  }
  reader7.releaseLock();
}

main().then(() => {
  for (const line of log) console.log(line);
});
