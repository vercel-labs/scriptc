// stream[Symbol.asyncDispose]() and `await using` from typed code, on
// each stream class and on a subclass.
import { PassThrough, Readable, Writable } from "node:stream";

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const noop = (_chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void => callback();
const describe = (error: Error | null): string => (error === null ? "null" : `${error.name} ${error.message}`);

class Ticker extends Readable {
  ticks = 0;
  _read(): void {
    this.ticks += 1;
    if (this.ticks < 3) this.push(String(this.ticks));
  }
}

class Guarded extends Readable {
  _read(): void {}
  async [Symbol.asyncDispose](): Promise<void> {
    console.log("guarded dispose", this.destroyed);
  }
}
class GuardedSink extends Writable {
  _write(_chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
    callback();
  }
  async [Symbol.asyncDispose](): Promise<void> {
    console.log("guarded sink dispose", this.destroyed);
  }
}

// Overrides whose parameters a call can omit: Node calls the method with no
// argument, so an optional one is undefined and a defaulted one takes its
// default.
class Lenient extends Readable {
  _read(): void {}
  async [Symbol.asyncDispose](reason?: string): Promise<void> {
    console.log("lenient dispose", reason === undefined ? "no reason" : reason, this.destroyed);
  }
}
class LenientSink extends Writable {
  _write(_chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
    callback();
  }
  async [Symbol.asyncDispose](mode = "default", ...rest: number[]): Promise<void> {
    console.log("lenient sink dispose", mode, rest.length, this.destroyed);
  }
}

let built = 0;
function makeGuarded(): Guarded {
  built += 1;
  return new Guarded();
}

async function disposeReadable(value: Readable): Promise<void> {
  await value[Symbol.asyncDispose]();
}
async function disposeWritable(value: Writable): Promise<void> {
  await value[Symbol.asyncDispose]();
}

async function main(): Promise<void> {
  const readable = Readable.from(["a", "b"]);
  readable.on("error", (error) => console.log("readable error event", error.name));
  readable.on("close", () => console.log("readable close event"));
  const disposed: Promise<void> = readable[Symbol.asyncDispose]();
  console.log("readable sync", readable.destroyed, describe(readable.errored));
  await disposed;
  console.log("readable after", readable.destroyed, readable.closed);

  const ended = new Readable({ read() {}, autoDestroy: false });
  ended.push(null);
  ended.resume();
  await turn();
  await disposeReadable(ended);
  console.log("ended", ended.destroyed, describe(ended.errored));

  const writable = new Writable({ write: noop });
  writable.write("x");
  await disposeWritable(writable);
  console.log("writable", writable.destroyed, describe(writable.errored));

  const finished = new Writable({ write: noop, autoDestroy: false });
  finished.end("x");
  await turn();
  await finished[Symbol.asyncDispose]();
  console.log("finished", finished.destroyed, describe(finished.errored));

  // A PassThrough, directly and as its Readable base.
  const through = new PassThrough();
  await disposeReadable(through);
  console.log("through as Readable", through.destroyed, describe(through.errored));
  const other = new PassThrough();
  await other[Symbol.asyncDispose]();
  console.log("through", other.destroyed, describe(other.errored));

  const ticker = new Ticker();
  ticker.resume();
  await turn();
  await ticker[Symbol.asyncDispose]();
  console.log("subclass", ticker.destroyed, ticker.ticks, describe(ticker.errored));

  // A subclass that overrides [Symbol.asyncDispose] keeps its override when
  // the value is held by a base-class binding.
  const guarded = new Guarded();
  const guardedBase: Readable = guarded;
  await guardedBase[Symbol.asyncDispose]();
  console.log("guarded base", guarded.destroyed, describe(guarded.errored));

  const guardedSink = new GuardedSink();
  const guardedSinkBase: Writable = guardedSink;
  await guardedSinkBase[Symbol.asyncDispose]();
  console.log("guarded sink base", guardedSink.destroyed, describe(guardedSink.errored));

  const guardedScoped = new Guarded();
  {
    await using scopedBase: Readable = guardedScoped;
    console.log("guarded using inside", scopedBase.destroyed);
  }
  console.log("guarded using", guardedScoped.destroyed, describe(guardedScoped.errored));

  // The same through overrides that declare parameters a call can omit.
  const lenient = new Lenient();
  const lenientBase: Readable = lenient;
  await lenientBase[Symbol.asyncDispose]();
  console.log("lenient base", lenient.destroyed, describe(lenient.errored));
  const lenientSink = new LenientSink();
  const lenientSinkBase: Writable = lenientSink;
  await lenientSinkBase[Symbol.asyncDispose]();
  console.log("lenient sink base", lenientSink.destroyed, describe(lenientSink.errored));
  const lenientScoped = new Lenient();
  {
    await using scopedLenient: Readable = lenientScoped;
    console.log("lenient using inside", scopedLenient.destroyed);
  }
  console.log("lenient using", lenientScoped.destroyed, describe(lenientScoped.errored));
  // On its own type the override takes the arguments it is given.
  await lenient[Symbol.asyncDispose]("asked");
  await lenientSink[Symbol.asyncDispose]("explicit", 1, 2);

  // The receiver is evaluated once.
  await makeGuarded()[Symbol.asyncDispose]();
  console.log("guarded once", built);

  // A native stream under the same base type still takes the runtime path.
  const nativeBase: Readable = Readable.from(["n"]);
  await nativeBase[Symbol.asyncDispose]();
  console.log("native base", nativeBase.destroyed, describe(nativeBase.errored));

  const failed = new Readable({ read() {} });
  failed.on("error", () => {});
  failed.destroy(new Error("earlier failure"));
  await turn();
  try {
    await failed[Symbol.asyncDispose]();
    console.log("failed resolved");
  } catch (error) {
    console.log("failed rejected", error instanceof Error ? error.message : "?");
  }

  let seen: Readable | null = null;
  {
    await using scoped = Readable.from(["a"]);
    seen = scoped;
    console.log("using inside", scoped.destroyed);
  }
  console.log("using readable", seen.destroyed, describe(seen.errored));
  let sink: Writable | null = null;
  {
    await using scoped = new Writable({ write: noop });
    sink = scoped;
    scoped.write("x");
  }
  console.log("using writable", sink.destroyed, describe(sink.errored));
}

main();
