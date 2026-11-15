// The readable state getters and lifecycle events, read at every step of a
// stream's life: the construction values in byte and object mode, the
// readableFlowing triple through 'readable', paused reads and flowing
// 'data', readableLength and readableDidRead as chunks are buffered and
// consumed, readableEnded/readable/closing around 'end' and 'close',
// readableEncoding before and after setEncoding and from the option, and
// the 'error'/readableAborted pair from push(error) and destroy(error)
// versus a clean end.
import { PassThrough, Readable } from "node:stream";

function log(...parts: unknown[]): void {
  console.log(parts.map((part) => String(part)).join(" "));
}

function once(emitter: object, event: string): Promise<void> {
  return new Promise((resolve) => (emitter as any).once(event, () => resolve()));
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function state(r: Readable): string {
  return [
    r.readable,
    r.readableEnded,
    r.readableFlowing,
    r.readableLength,
    r.readableHighWaterMark,
    r.readableObjectMode,
    r.readableAborted,
    r.readableDidRead,
    r.readableEncoding === null ? "null" : r.readableEncoding,
    r.closed,
    r.destroyed,
    r.errored === null ? "null" : r.errored.message,
  ].join(",");
}

// The construction state in byte and object mode, and a custom high-water
// mark.
{
  const bytes = new Readable({ read() {} });
  log("byte initial", state(bytes));
  const objects = new Readable({ objectMode: true, read() {} });
  log("object initial", state(objects));
  const sized = new Readable({ highWaterMark: 5, read() {} });
  log("sized initial", sized.readableHighWaterMark, sized.readableObjectMode);
  const closed = once(sized, "close");
  sized.destroy();
  await closed;
  log("destroyed initial", sized.destroyed, sized.readable, sized.readableAborted);
}

// A paused consumer: push() buffers, 'readable' fires, read() consumes, and
// readableDidRead tracks the first read.
{
  const r = new Readable({ read() {} });
  const events: string[] = [];
  r.on("readable", () =>
    events.push(`readable ${r.readableLength} ${r.readableFlowing} ${r.readableDidRead}`),
  );
  r.push("ab");
  log("pushed", state(r), r.isPaused());
  await tick();
  log("readable event", events.join(" | "), r.readableLength, r.readableFlowing);
  log("read", String(r.read()), state(r));
  r.push(Buffer.from("cd"));
  await tick();
  log("read again", String(r.read()), state(r));
  const ended = once(r, "end");
  const closed = once(r, "close");
  r.push(null);
  await tick();
  log("eof readable", r.readableLength, r.readableEnded, r.readableFlowing);
  log("eof read", String(r.read()), r.readableEnded);
  await ended;
  log("ended", state(r));
  await closed;
  log("closed", state(r), r.readable);
}

// A flowing consumer: 'data' emits each chunk and turns readableFlowing
// true, 'end' follows the last chunk, and 'close' follows 'end'.
{
  const r = new Readable({ read() {} });
  const events: string[] = [];
  const closed = once(r, "close");
  r.on("resume", () => events.push(`resume ${r.readableFlowing}`));
  r.on("pause", () => events.push(`pause ${r.readableFlowing}`));
  r.on("data", (chunk: unknown) =>
    events.push(`data ${String(chunk)} ${r.readableFlowing} ${r.readableDidRead} ${r.readableLength}`),
  );
  r.on("end", () =>
    events.push(`end ${r.readableEnded} ${r.readableFlowing} ${r.readableLength}`),
  );
  r.on("close", () => events.push(`close ${r.closed} ${r.destroyed} ${r.readableAborted}`));
  log("before push", state(r));
  r.push("a");
  r.push("b");
  r.push(null);
  await closed;
  log("flowed", events.join(" | "), state(r));
}

// The paused state and its 'pause'/'resume' events.
{
  const r = new Readable({ read() {} });
  const events: string[] = [];
  r.on("pause", () => events.push(`pause ${r.readableFlowing}`));
  r.on("resume", () => events.push(`resume ${r.readableFlowing}`));
  r.on("data", (chunk: unknown) => {
    events.push(`data ${String(chunk)} ${r.readableFlowing}`);
  });
  log("start", state(r), r.isPaused());
  r.resume();
  log("after resume", r.readableFlowing, r.isPaused());
  r.push("x");
  await tick();
  log("after chunk", r.readableFlowing, r.isPaused(), r.readableLength);
  r.pause();
  log("after pause", r.readableFlowing, r.isPaused());
  r.push("y");
  log("paused buffer", r.readableLength, r.readableFlowing);
  r.resume();
  log("after resume again", r.readableFlowing, r.isPaused());
  r.push(null);
  const closed = once(r, "close");
  await closed;
  log("pause sequence", events.join(" | "), state(r));
}

// push(error) destroys the stream with that error and marks it aborted.
{
  const err = new Error("read failed");
  const events: string[] = [];
  const r = new Readable({ read() {} });
  r.on("error", (error: Error) =>
    events.push(`error ${error === err} ${r.errored === err} ${r.destroyed} ${r.readableAborted}`),
  );
  r.on("close", () => events.push(`close ${r.closed} ${r.destroyed} ${r.readableAborted}`));
  const closed = once(r, "close");
  r.push(err);
  await closed;
  log("push error", events.join(" | "), state(r), r.readable);
}

// destroy() closes without 'error', and destroy(error) reports it.
{
  const quiet = new Readable({ read() {} });
  const quietClosed = once(quiet, "close");
  quiet.destroy();
  log("quiet sync", state(quiet));
  await quietClosed;
  log("quiet done", state(quiet), quiet.errored === null);
}
{
  const err = new Error("destroyed");
  const events: string[] = [];
  const r = new Readable({ read() {} });
  r.on("error", (error: Error) => events.push(`error ${error === err} ${r.errored === err}`));
  r.on("close", () => events.push(`close ${r.closed} ${r.destroyed} ${r.readableAborted}`));
  const closed = once(r, "close");
  r.destroy(err);
  log("destroy sync", state(r));
  await closed;
  log("destroy sequence", events.join(" | "), state(r));
}

// readableEncoding before and after setEncoding, and from the option.
{
  const plain = new Readable({ read() {} });
  log("encoding initial", plain.readableEncoding);
  plain.setEncoding("utf-8");
  log("encoding set", plain.readableEncoding, plain.readableDidRead);
  plain.push(Buffer.from([0x68, 0xc3, 0xa9]));
  await tick();
  log("encoding chunk", String(plain.read()), plain.readableEncoding, plain.readableDidRead);
  const closed = once(plain, "close");
  plain.push(null);
  await tick();
  log("encoding eof read", String(plain.read()), plain.readableEnded);
  await closed;
  const option = new Readable({ encoding: "hex", read() {} });
  log("option encoding", option.readableEncoding, option.readableLength);
  option.destroy();
}

// A Transform's readable side reaches 'end' after its writable side ends.
{
  const transform = new PassThrough();
  const chunks: string[] = [];
  const events: string[] = [];
  transform.on("data", (chunk: unknown) => chunks.push(String(chunk)));
  transform.on("end", () =>
    events.push(`end ${transform.readableEnded} ${transform.readableLength}`),
  );
  transform.on("finish", () => events.push(`finish ${transform.writableFinished}`));
  const closed = once(transform, "close");
  transform.end("x");
  await closed;
  log("transform end", chunks.join(","), events.join(" | "), transform.readableEnded);
}

// readableAborted stays false for a stream that reached 'end'.
{
  const r = new Readable({ read() {} });
  const closed = once(r, "close");
  r.push("a");
  r.resume();
  r.push(null);
  await closed;
  log("natural end", r.readableEnded, r.readableAborted, r.destroyed, r.closed);
}
