// Readable's async-iteration surface: `for await` over byte and object
// mode streams, the iterator([options]) entry point with destroyOnReturn
// true and false, break/return/throw closing the stream (or keeping it
// with destroyOnReturn: false), and readable/writable[Symbol.asyncDispose]()
// called directly and through `await using`.
import { PassThrough, Readable, Writable } from "node:stream";

const describe = (error: unknown): string =>
  error === null || error === undefined
    ? "none"
    : `${(error as Error).name} ${(error as NodeJS.ErrnoException).code ?? "-"} ${(error as Error).message}`;
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// ── full consumption ──────────────────────────────────────────────────
{
  const bytes = Readable.from([Buffer.from("a"), Buffer.from("b")]);
  for await (const chunk of bytes) console.log("bytes", Buffer.isBuffer(chunk), chunk.toString());
  console.log("bytes state", bytes.readableEnded, bytes.readableDidRead, bytes.destroyed);

  const objects = Readable.from([{ n: 1 }, { n: 2 }], { objectMode: true });
  for await (const value of objects) console.log("objects", typeof value, value.n);
  console.log("objects state", objects.readableEnded, objects.readableObjectMode);

  const empty = Readable.from([]);
  for await (const value of empty) console.log("empty value", value);
  console.log("empty state", empty.readableEnded);
}

// ── the iterator() entry point and its destroyOnReturn option ─────────
{
  const quietStream = Readable.from(["a"]);
  for await (const chunk of quietStream.iterator({ destroyOnReturn: false })) {
    console.log("kept chunk", chunk);
    break;
  }
  console.log("kept after break", quietStream.destroyed, quietStream.readableEnded);
  while (true) {
    const next = quietStream.read();
    if (next === null) break;
    console.log("kept rest", String(next));
  }
  await turn();
  console.log("kept end", quietStream.destroyed, quietStream.readableEnded);

  const closing = Readable.from(["a", "b"]);
  for await (const chunk of closing.iterator({ destroyOnReturn: true })) {
    console.log("closing chunk", chunk);
    break;
  }
  await turn();
  console.log("closing state", closing.destroyed, describe(closing.errored));
}

// ── leaving a for-await loop ──────────────────────────────────────────
{
  const broken = Readable.from(["a", "b", "c"]);
  broken.on("error", (error: Error) => console.log("broken error event", describe(error)));
  for await (const chunk of broken) {
    console.log("broken chunk", chunk);
    break;
  }
  await turn();
  console.log("broken state", broken.destroyed, describe(broken.errored));

  const returned = Readable.from(["a", "b", "c"]);
  async function consumeOne(stream: Readable): Promise<string> {
    for await (const chunk of stream) return String(chunk);
    return "none";
  }
  console.log("returned value", await consumeOne(returned));
  await turn();
  console.log("returned state", returned.destroyed, describe(returned.errored));

  const thrown = Readable.from(["a", "b"]);
  thrown.on("error", () => {});
  try {
    for await (const chunk of thrown) {
      console.log("thrown chunk", chunk);
      throw new Error("loop body");
    }
  } catch (error) {
    console.log("thrown caught", describe(error));
  }
  await turn();
  console.log("thrown state", thrown.destroyed, describe(thrown.errored));

  const preserving = Readable.from(["a", "b"]);
  for await (const chunk of preserving.iterator({ destroyOnReturn: false })) {
    console.log("preserving chunk", chunk);
    break;
  }
  console.log("preserving state", preserving.destroyed, preserving.readableEnded);
  while (true) {
    const next = preserving.read();
    if (next === null) break;
    console.log("preserving rest", String(next));
  }
  await turn();
  console.log("preserving end", preserving.destroyed, preserving.readableEnded);
}

// ── an erroring stream rejects the loop ───────────────────────────────
{
  const failing = new Readable({ read() {} });
  failing.on("error", (error: Error) => console.log("failing error event", describe(error)));
  const loop = (async (): Promise<void> => {
    for await (const chunk of failing) console.log("failing chunk", chunk);
  })();
  failing.push("first");
  failing.destroy(new Error("iteration stopped"));
  try {
    await loop;
    console.log("failing loop resolved");
  } catch (error) {
    console.log("failing loop rejected", describe(error));
  }
  await turn();
  console.log("failing state", failing.destroyed, describe(failing.errored));
}

// ── async iteration over a from-iterable stream built at run time ─────
{
  const pending = new PassThrough({ objectMode: true });
  const loop = (async (): Promise<string[]> => {
    const seen: string[] = [];
    for await (const value of pending) seen.push(String(value));
    return seen;
  })();
  pending.write("one");
  pending.write("two");
  pending.end();
  console.log("pending seen", (await loop).join(","));
  console.log("pending state", pending.readableEnded, pending.destroyed);
}

// ── readable[Symbol.asyncDispose]() ───────────────────────────────────
{
  const readable = Readable.from(["a", "b"]);
  readable.on("error", (error: Error) => console.log("dispose readable error event", describe(error)));
  readable.on("close", () => console.log("dispose readable close", readable.closed));
  const disposing = readable[Symbol.asyncDispose]();
  console.log("dispose readable sync", readable.destroyed, describe(readable.errored));
  await disposing;
  console.log("dispose readable after", readable.destroyed, describe(readable.errored));

  const ended = new Readable({ read() {}, autoDestroy: false });
  ended.push(null);
  ended.resume();
  await turn();
  console.log("dispose ended before", ended.readableEnded, ended.destroyed);
  await ended[Symbol.asyncDispose]();
  console.log("dispose ended after", ended.destroyed, describe(ended.errored));

  {
    let scoped: Readable | null = null;
    {
      await using stream = Readable.from(["a"]);
      scoped = stream;
      console.log("using inside", stream.destroyed);
    }
    console.log("using after", scoped!.destroyed, describe(scoped!.errored));
  }

  const failed = new Readable({ read() {} });
  failed.on("error", () => {});
  failed.destroy(new Error("earlier"));
  await turn();
  try {
    await failed[Symbol.asyncDispose]();
    console.log("dispose failed resolved");
  } catch (error) {
    console.log("dispose failed rejected", describe(error), error === failed.errored);
  }
}

// ── writable[Symbol.asyncDispose]() ───────────────────────────────────
{
  const writable = new Writable({
    write(_chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
      callback();
    },
  });
  writable.on("error", (error: Error) => console.log("dispose writable error event", describe(error)));
  writable.write("x");
  const disposing = writable[Symbol.asyncDispose]();
  console.log("dispose writable sync", writable.destroyed, describe(writable.errored));
  await disposing;
  console.log("dispose writable after", writable.destroyed, describe(writable.errored));

  {
    let scoped: Writable | null = null;
    {
      await using sink = new Writable({
        write(_chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
          callback();
        },
      });
      scoped = sink;
      sink.write("x");
    }
    console.log("using writable after", scoped!.destroyed, describe(scoped!.errored));
  }
}
