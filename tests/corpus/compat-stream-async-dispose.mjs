// readable[Symbol.asyncDispose]() and writable[Symbol.asyncDispose](),
// called directly and through `await using`: an unfinished stream is
// destroyed with an AbortError and the promise settles once the stream
// has finished; a finished one is destroyed without an error; a stream
// that failed earlier rejects with its own error.
import { Duplex, PassThrough, Readable, Writable } from "node:stream";

const turn = () => new Promise((resolve) => setImmediate(resolve));
const noop = (_chunk, _encoding, callback) => callback();
const describe = (error) => (error === null ? "null" : `${error.name} ${error.code} ${error.message}`);
// How a dispose promise settles.
async function settled(promise) {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    return `rejected ${error.code ?? error.message}`;
  }
}

// An unfinished Readable: AbortError, then 'error' and 'close' before the
// promise settles.
{
  const readable = Readable.from(["a", "b"]);
  readable.on("error", (error) => console.log("readable error event", error.name));
  readable.on("close", () => console.log("readable close event"));
  const disposed = readable[Symbol.asyncDispose]();
  console.log("readable sync", readable.destroyed, describe(readable.errored), disposed instanceof Promise);
  console.log("readable", await settled(disposed));
  console.log("readable after", readable.destroyed, readable.closed);
}

// Without an 'error' listener the AbortError is not an unhandled error.
{
  const readable = new Readable({ read() {} });
  await readable[Symbol.asyncDispose]();
  console.log("quiet readable", readable.destroyed, describe(readable.errored));
}

// A Readable that already ended is destroyed without an error.
{
  const readable = new Readable({ read() {}, autoDestroy: false });
  readable.push(null);
  readable.resume();
  await turn();
  console.log("ended before", readable.readableEnded, readable.destroyed);
  await readable[Symbol.asyncDispose]();
  console.log("ended after", readable.destroyed, describe(readable.errored));
}

// An unfinished Writable, and a finished one.
{
  const writable = new Writable({ write: noop });
  writable.on("error", (error) => console.log("writable error event", error.name));
  writable.write("x");
  const disposed = writable[Symbol.asyncDispose]();
  console.log("writable sync", writable.destroyed, describe(writable.errored));
  console.log("writable", await settled(disposed));

  const finished = new Writable({ write: noop, autoDestroy: false });
  finished.end("x");
  await turn();
  console.log("finished before", finished.writableFinished, finished.destroyed);
  await finished[Symbol.asyncDispose]();
  console.log("finished after", finished.destroyed, describe(finished.errored));
}

// A Duplex takes Readable's form: it asks whether the readable side
// ended. One whose readable side ended is destroyed without an error, and
// its unfinished writable side then closes early.
{
  const through = new PassThrough();
  console.log("through", await settled(through[Symbol.asyncDispose]()), through.destroyed, describe(through.errored));

  const duplex = new Duplex({ read() {}, write: noop, autoDestroy: false });
  duplex.push(null);
  duplex.resume();
  await turn();
  console.log("duplex half ended", await settled(duplex[Symbol.asyncDispose]()), duplex.destroyed, describe(duplex.errored));

  const done = new Duplex({ read() {}, write: noop, autoDestroy: false });
  done.push(null);
  done.resume();
  done.end();
  await turn();
  console.log("duplex ended", await settled(done[Symbol.asyncDispose]()), done.destroyed, describe(done.errored));
}

// A stream that failed before is not destroyed again; the promise rejects
// with the stream's own error.
{
  const failed = new Readable({ read() {} });
  failed.on("error", () => {});
  failed.destroy(new Error("earlier failure"));
  await turn();
  try {
    await failed[Symbol.asyncDispose]();
    console.log("failed readable resolved");
  } catch (error) {
    console.log("failed readable rejected", error.message, error === failed.errored);
  }
  const aborted = new Readable({ read() {} });
  aborted.on("error", () => {});
  const abortError = new Error("named like an abort");
  abortError.name = "AbortError";
  aborted.destroy(abortError);
  await turn();
  console.log("readable with an AbortError of its own", await settled(aborted[Symbol.asyncDispose]()));

  const failedSink = new Writable({ write: noop });
  failedSink.on("error", () => {});
  failedSink.destroy(new Error("sink failure"));
  await turn();
  console.log("failed writable", await settled(failedSink[Symbol.asyncDispose]()));
  const abortedSink = new Writable({ write: noop });
  abortedSink.on("error", () => {});
  const sinkAbort = new Error("named like an abort");
  sinkAbort.name = "AbortError";
  abortedSink.destroy(sinkAbort);
  await turn();
  console.log("writable with an AbortError of its own", await settled(abortedSink[Symbol.asyncDispose]()));
}

// A stream destroyed without an error before it ended closed early.
{
  const early = new Readable({ read() {} });
  early.destroy();
  await turn();
  console.log("early", await settled(early[Symbol.asyncDispose]()));
}

// When the promise settles, against the stream's own events and the
// microtasks queued beside it.
{
  const order = [];
  const readable = new Readable({ read() {} });
  readable.on("error", () => order.push("error"));
  readable.on("close", () => order.push("close"));
  const disposed = readable[Symbol.asyncDispose]().then(() => order.push("disposed"));
  process.nextTick(() => order.push("tick"));
  Promise.resolve().then(() => order.push("microtask"));
  setImmediate(() => order.push("immediate"));
  await disposed;
  await turn();
  console.log("order", order.join(" "));
}

// await using disposes at the end of the block.
{
  let seen;
  {
    await using readable = Readable.from(["a"]);
    seen = readable;
    console.log("using inside", readable.destroyed);
  }
  console.log("using readable", seen.destroyed, describe(seen.errored));

  let sink;
  {
    await using writable = new Writable({ write: noop });
    sink = writable;
    writable.write("x");
  }
  console.log("using writable", sink.destroyed, describe(sink.errored));
}

// A subclass that overrides [Symbol.asyncDispose] keeps its override when
// the value is held by a base-class binding.
{
  class Guarded extends Readable {
    _read() {}
    async [Symbol.asyncDispose]() {
      console.log("guarded dispose", this.destroyed);
    }
  }
  class GuardedSink extends Writable {
    _write(_chunk, _encoding, callback) {
      callback();
    }
    async [Symbol.asyncDispose]() {
      console.log("guarded sink dispose", this.destroyed);
    }
  }
  const guarded = new Guarded();
  /** @type {Readable} */
  const base = guarded;
  await base[Symbol.asyncDispose]();
  console.log("guarded base", guarded.destroyed, describe(guarded.errored));

  const sink = new GuardedSink();
  /** @type {Writable} */
  const sinkBase = sink;
  await sinkBase[Symbol.asyncDispose]();
  console.log("guarded sink base", sink.destroyed, describe(sink.errored));

  const scoped = new Guarded();
  /** @type {Readable} */
  const scopedBase = scoped;
  {
    await using bound = scopedBase;
    console.log("guarded using inside", bound.destroyed);
  }
  console.log("guarded using", scoped.destroyed, describe(scoped.errored));

  // Overrides that declare parameters: Node calls the method with no
  // argument, so a plain parameter is undefined and a defaulted one takes
  // its default.
  class Lenient extends Readable {
    _read() {}
    async [Symbol.asyncDispose](reason) {
      console.log("lenient dispose", reason === undefined ? "no reason" : reason, this.destroyed);
    }
  }
  class LenientSink extends Writable {
    _write(_chunk, _encoding, callback) {
      callback();
    }
    async [Symbol.asyncDispose](mode = "default", ...rest) {
      console.log("lenient sink dispose", mode, rest.length, this.destroyed);
    }
  }
  const lenient = new Lenient();
  /** @type {Readable} */
  const lenientBase = lenient;
  await lenientBase[Symbol.asyncDispose]();
  console.log("lenient base", lenient.destroyed, describe(lenient.errored));
  const lenientSink = new LenientSink();
  /** @type {Writable} */
  const lenientSinkBase = lenientSink;
  await lenientSinkBase[Symbol.asyncDispose]();
  console.log("lenient sink base", lenientSink.destroyed, describe(lenientSink.errored));
  const lenientScoped = new Lenient();
  /** @type {Readable} */
  const lenientScopedBase = lenientScoped;
  {
    await using boundLenient = lenientScopedBase;
    console.log("lenient using inside", boundLenient.destroyed);
  }
  console.log("lenient using", lenientScoped.destroyed, describe(lenientScoped.errored));

  // A native stream under the same base type still takes the runtime path.
  /** @type {Readable} */
  const native = Readable.from(["n"]);
  await native[Symbol.asyncDispose]();
  console.log("native base", native.destroyed, describe(native.errored));
}
