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
