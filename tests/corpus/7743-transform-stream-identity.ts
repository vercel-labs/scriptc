// The identity TransformStream: writes wait for reads (the readable side's
// high-water mark is 0), the writer's desiredSize/ready track the writable
// side's queue, close/abort/cancel propagate across the pair (in either
// order when they race), and the readable side feeds a Response body (the
// StreamingApi pattern of Hono's stream helpers).
const enc = new TextEncoder();
const dec = new TextDecoder();

function describe(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as NodeJS.ErrnoException).code;
    return `${e.name}: ${e.message}${code === undefined ? "" : ` [${code}]`}`;
  }
  return `value ${String(e)}`;
}

async function basics(): Promise<void> {
  const ts = new TransformStream<string, string>();
  const writer = ts.writable.getWriter();
  const reader = ts.readable.getReader();
  console.log("desired", writer.desiredSize, ts.writable.locked, ts.readable.locked);
  const written = writer.write("a").then(() => console.log("write a done"));
  console.log("desired after write", writer.desiredSize);
  void writer.ready.then(() => console.log("ready"));
  const first = await reader.read();
  console.log("read", first.done, first.value);
  await written;
  console.log("desired", writer.desiredSize);
  const closing = writer.close().then(() => console.log("closed"));
  const last = await reader.read();
  console.log("read", last.done, last.value);
  await closing;
  await writer.closed;
  console.log("writer.closed resolved");
  try {
    await writer.write("b");
  } catch (e) {
    console.log("write after close:", describe(e));
  }
  try {
    ts.writable.getWriter();
  } catch (e) {
    console.log("getWriter locked:", describe(e));
  }
  writer.releaseLock();
  try {
    await writer.write("c");
  } catch (e) {
    console.log("released write:", describe(e));
  }
  try {
    await writer.closed;
  } catch (e) {
    console.log("released closed:", describe(e));
  }
}

async function abortWriter(): Promise<void> {
  const ts = new TransformStream<string, string>();
  const writer = ts.writable.getWriter();
  const reader = ts.readable.getReader();
  const pending = writer.write("z").catch((e: unknown) => console.log("pending write:", describe(e)));
  await writer.abort("boom").then(() => console.log("abort resolved"));
  await pending;
  try {
    await reader.read();
  } catch (e) {
    console.log("read after abort:", describe(e));
  }
  try {
    await writer.closed;
  } catch (e) {
    console.log("closed after abort:", describe(e));
  }
  try {
    await writer.ready;
  } catch (e) {
    console.log("ready after abort:", describe(e));
  }
  console.log("desired after abort", writer.desiredSize);
}

async function cancelReadable(): Promise<void> {
  const ts = new TransformStream<string, string>();
  const writer = ts.writable.getWriter();
  const pending = writer.write("q").catch((e: unknown) => console.log("write rejected by cancel:", describe(e)));
  await ts.readable.cancel("nope").then(() => console.log("cancel resolved"));
  await pending;
  try {
    await writer.closed;
  } catch (e) {
    console.log("writer.closed after cancel:", describe(e));
  }
}

async function intoResponse(): Promise<void> {
  const ts = new TransformStream<Uint8Array, Uint8Array>();
  const writer = ts.writable.getWriter();
  void (async (): Promise<void> => {
    for (const s of ["x", "y", "z"]) {
      await writer.write(enc.encode(s));
      console.log("wrote", s);
    }
    await writer.close();
    console.log("writer closed");
  })();
  console.log("text", await new Response(ts.readable).text());
}

/** Hono's StreamingApi: a writer on the writable side and a pull-based
 * ReadableStream over a reader of the readable side. */
interface StreamingApi {
  readonly responseReadable: ReadableStream<Uint8Array>;
  write(input: string): Promise<void>;
  close(): Promise<void>;
  state(): string;
}

function streamingApi(writable: WritableStream<Uint8Array>, readable: ReadableStream<Uint8Array>): StreamingApi {
  const writer = writable.getWriter();
  const reader = readable.getReader();
  let closed = false;
  let aborted = false;
  const responseReadable = new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel: (): void => {
      if (!closed) aborted = true;
    },
  });
  return {
    responseReadable,
    async write(input: string): Promise<void> {
      try {
        await writer.write(enc.encode(input));
      } catch {
        // a closed or aborted stream drops the write
      }
    },
    async close(): Promise<void> {
      closed = true;
      try {
        await writer.close();
      } catch {
        // already closed
      }
    },
    state: (): string => `closed=${String(closed)} aborted=${String(aborted)}`,
  };
}

async function streamedResponse(): Promise<void> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const api = streamingApi(writable, readable);
  void (async (): Promise<void> => {
    try {
      for (let i = 0; i < 3; i++) {
        await api.write(`data: ${i}\n\n`);
      }
    } finally {
      await api.close();
    }
  })();
  const response = new Response(api.responseReadable, { headers: { "content-type": "text/event-stream" } });
  const reader = response.body!.getReader();
  let chunks = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks++;
    text += dec.decode(value);
  }
  console.log("streamed", chunks, JSON.stringify(text), api.state());
}

async function writableMethods(): Promise<void> {
  const a = new TransformStream<string, string>();
  await a.writable.abort("r").then(() => console.log("writable.abort ok"));
  const b = new TransformStream<string, string>();
  const writer = b.writable.getWriter();
  try {
    await b.writable.close();
  } catch (e) {
    console.log("close locked:", describe(e));
  }
  try {
    await b.writable.abort();
  } catch (e) {
    console.log("abort locked:", describe(e));
  }
  writer.releaseLock();
  const reader = b.readable.getReader();
  const closing = b.writable.close().then(() => console.log("writable.close ok"));
  const end = await reader.read();
  console.log("readable done", end.done);
  await closing;
}

// writable.abort() and readable.cancel() share the transform's finish
// promise: whichever runs second answers the first one's result.
function settled(label: string, p: Promise<void>): Promise<void> {
  return p.then(
    () => console.log(label, "fulfilled"),
    (e: unknown) => console.log(label, "rejected", describe(e)),
  );
}

async function abortCancelRaces(): Promise<void> {
  const a = new TransformStream<string, string>();
  const aWriter = a.writable.getWriter();
  await new Promise((r) => setTimeout(r, 0));
  const aborted = settled("abort then cancel: abort", aWriter.abort("abort first"));
  const cancelled = settled("abort then cancel: cancel", a.readable.cancel("cancel second"));
  await aborted;
  await cancelled;
  const b = new TransformStream<string, string>();
  const bWriter = b.writable.getWriter();
  await new Promise((r) => setTimeout(r, 0));
  const cancelledFirst = settled("cancel then abort: cancel", b.readable.cancel("cancel first"));
  const abortedSecond = settled("cancel then abort: abort", bWriter.abort("abort second"));
  await cancelledFirst;
  await abortedSecond;
}

async function main(): Promise<void> {
  await basics();
  await abortWriter();
  await cancelReadable();
  await intoResponse();
  await streamedResponse();
  await writableMethods();
  await abortCancelRaces();
}

await main();
