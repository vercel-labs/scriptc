// The writable state getters and lifecycle events, read at every step of a
// stream's life: the construction values in byte and object mode, the
// length/return/needDrain triple while writes are in flight, the cork
// depth across uncork, the writableEnded/writableFinished/writable
// transitions around end(), the 'error' and 'close' pair from a failed
// _write callback and from destroy(error), a quiet destroy, and the
// 'pipe' and 'unpipe' events the writable receives from a source.
import { PassThrough, Readable, Writable } from "node:stream";

type Done = (error?: Error | null) => void;

function log(...parts: unknown[]): void {
  console.log(parts.map((part) => String(part)).join(" "));
}

function once(emitter: object, event: string): Promise<void> {
  return new Promise((resolve) => (emitter as any).once(event, () => resolve()));
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function state(w: Writable): string {
  return [
    w.writable,
    w.writableEnded,
    w.writableFinished,
    w.writableLength,
    w.writableCorked,
    w.writableHighWaterMark,
    w.writableObjectMode,
    w.writableNeedDrain,
    w.writableAborted,
    w.closed,
    w.destroyed,
    w.errored === null ? "null" : w.errored.message,
  ].join(",");
}

function write(_chunk: unknown, _encoding: unknown, callback: Done): void {
  callback();
}

// The construction state in byte and object mode, and a custom high-water
// mark.
{
  const bytes = new Writable({ write });
  log("byte initial", state(bytes));
  const objects = new Writable({ objectMode: true, write });
  log("object initial", state(objects));
  const sized = new Writable({ highWaterMark: 5, write });
  log("sized initial", sized.writableHighWaterMark, sized.writableObjectMode);
  const bytesClosed = once(bytes, "close");
  const objectsClosed = once(objects, "close");
  const sizedClosed = once(sized, "close");
  bytes.destroy();
  objects.destroy();
  sized.destroy();
  await Promise.all([bytesClosed, objectsClosed, sizedClosed]);
  log("destroyed initial", bytes.destroyed, bytes.writable, bytes.writableAborted);
}

// The write return value writes past a small high-water mark, and 'drain'
// clears writableNeedDrain.
{
  const w = new Writable({
    highWaterMark: 2,
    write(_chunk: unknown, _encoding: unknown, callback: Done) {
      setTimeout(callback, 5);
    },
  });
  log("write first", w.write("aa"), w.writableLength, w.writableNeedDrain);
  log("write second", w.write("bb"), w.writableLength, w.writableNeedDrain);
  await once(w, "drain");
  log("drained", w.writableLength, w.writableNeedDrain);
  const finished = once(w, "finish");
  const closed = once(w, "close");
  w.end();
  await finished;
  log("after finish", state(w));
  await closed;
  log("after close", state(w));
}

// cork() stacks, and uncork() releases the batch through _writev.
{
  const calls: string[] = [];
  const w = new Writable({
    write(chunk: unknown, _encoding: unknown, callback: Done) {
      calls.push(`w ${String(chunk)}`);
      callback();
    },
    writev(chunks: Array<{ chunk: unknown }>, callback: Done) {
      calls.push(`v ${chunks.map((entry) => String(entry.chunk)).join("+")}`);
      callback();
    },
  });
  w.cork();
  w.cork();
  log("corked", w.writableCorked, w.writableLength, w.write("a"), w.writableLength);
  log("corked again", w.write("b"), w.writableLength, w.writableCorked);
  w.uncork();
  log("uncork one", w.writableCorked, calls.join(","));
  w.uncork();
  await tick();
  await tick();
  log("uncork two", w.writableCorked, calls.join(","), w.writableLength);
  const finished = once(w, "finish");
  const closed = once(w, "close");
  w.end();
  await finished;
  await closed;
  log("cork final", state(w), calls.join(","));
}

// 'finish', the end() callback and 'close' fire once each, in Node's
// order, and the flags are set before each fires.
{
  const events: string[] = [];
  const w = new Writable({ write });
  w.on("finish", () => events.push(`finish ${w.writableFinished} ${w.writableEnded} ${w.closed}`));
  w.on("close", () => events.push(`close ${w.closed} ${w.destroyed} ${w.writableAborted}`));
  const closed = once(w, "close");
  log("before end", state(w));
  w.end("x", () => events.push(`callback ${w.writableFinished} ${w.writableEnded} ${w.writableLength}`));
  log("after end sync", state(w));
  await closed;
  log("finish sequence", events.join(" | "), state(w));
}

// A _write callback with an error reports it through 'error' before
// 'close', sets errored, and marks the stream aborted.
{
  const events: string[] = [];
  const err = new Error("write failed");
  (err as { code?: string }).code = "EWRITE";
  const w = new Writable({
    write(_chunk: unknown, _encoding: unknown, callback: Done) {
      setTimeout(() => callback(err), 5);
    },
  });
  w.on("error", (error: Error) => {
    const code = (error as { code?: string }).code;
    events.push(
      `error ${error === err} ${error.message} ${code} ${w.errored === err} ${w.destroyed} ${w.writableAborted}`,
    );
  });
  w.on("close", () =>
    events.push(`close ${w.closed} ${w.destroyed} ${w.writableAborted} ${w.writableFinished}`),
  );
  const closed = once(w, "close");
  log("error write", w.write("x"), w.writableNeedDrain, w.writableLength);
  await closed;
  log("error sequence", events.join(" | "), state(w), w.writable);
}

// destroy() without an error closes without 'error'; destroy(error)
// reports the error and keeps errored set to it.
{
  const quiet = new Writable({ write });
  const quietClosed = once(quiet, "close");
  quiet.destroy();
  log("quiet sync", state(quiet));
  await quietClosed;
  log("quiet done", state(quiet), quiet.errored === null);
}
{
  const err = new Error("destroyed");
  const events: string[] = [];
  const w = new Writable({ write });
  w.on("error", (error: Error) => events.push(`error ${error === err} ${w.errored === err}`));
  w.on("close", () => events.push(`close ${w.closed} ${w.destroyed} ${w.errored === err}`));
  const closed = once(w, "close");
  w.destroy(err);
  log("destroy sync", state(w));
  await closed;
  log("destroy sequence", events.join(" | "), state(w));
}

// A Transform is a Writable too: its writable side ends with 'finish'.
{
  const transform = new PassThrough();
  const events: string[] = [];
  transform.on("finish", () =>
    events.push(`finish ${transform.writableFinished} ${transform.writableEnded}`),
  );
  transform.on("close", () => events.push(`close ${transform.closed}`));
  const closed = once(transform, "close");
  transform.resume();
  transform.end("x");
  await closed;
  log("transform finish", events.join(" | "), transform.writableFinished, transform.writableEnded);
}

// The destination receives 'pipe' when a source starts and 'unpipe' when
// it stops.
{
  const events: string[] = [];
  const dest = new Writable({ write });
  dest.on("pipe", (source: unknown) =>
    events.push(`pipe ${typeof (source as { pipe?: unknown }).pipe}`),
  );
  dest.on("unpipe", (source: unknown) =>
    events.push(`unpipe ${typeof (source as { pipe?: unknown }).pipe}`),
  );
  const source = Readable.from(["a", "b"]);
  const closed = once(dest, "close");
  source.pipe(dest);
  await closed;
  log("pipe sequence", events.join(" | "), dest.writableFinished, dest.writableEnded);
}
{
  const events: string[] = [];
  const dest = new Writable({ write });
  dest.on("pipe", () => events.push("pipe"));
  dest.on("unpipe", () => events.push("unpipe"));
  const source = Readable.from(["a", "b", "c"]);
  const closed = once(dest, "close");
  source.pipe(dest);
  await tick();
  source.unpipe(dest);
  dest.end();
  await closed;
  log("unpipe sequence", events.join(" | "), dest.writableFinished, dest.writableLength);
}
