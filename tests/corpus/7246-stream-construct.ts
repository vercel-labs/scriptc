// Deferred construction in typed code: the construct option and the
// _construct method on Readable, Writable, Duplex and Transform. Writes
// and reads wait for the callback, an error from it destroys the stream,
// a destroy while constructing reports both errors as an AggregateError,
// a throw inside construct is its error, and a second callback is
// ERR_MULTIPLE_CALLBACK.
import { EventEmitter } from "node:events";
import { Duplex, Readable, Transform, Writable } from "node:stream";

const log: string[] = [];

function ticks(count: number): void {
  let i = 0;
  const step = (): void => {
    log.push("t" + i);
    if (++i < count) process.nextTick(step);
  };
  process.nextTick(step);
}

class Store extends Writable {
  private ready = false;
  _construct(callback: (error?: Error | null) => void): void {
    log.push("store construct");
    setTimeout(() => {
      this.ready = true;
      log.push("store ready");
      callback();
    }, 2);
  }
  _write(chunk: Buffer, _enc: string, cb: (error?: Error | null) => void): void {
    log.push(`store write ${chunk.toString()} ready=${this.ready}`);
    cb();
  }
  _final(cb: (error?: Error | null) => void): void {
    log.push("store final");
    cb();
  }
}

class Pair extends Duplex {
  constructor() {
    super({ readableObjectMode: true });
  }
  _construct(callback: (error?: Error | null) => void): void {
    log.push("pair construct");
    process.nextTick(callback);
  }
  _read(): void {}
  _write(chunk: Buffer, _enc: string, cb: (error?: Error | null) => void): void {
    this.push({ got: chunk.toString() });
    cb();
  }
  _final(cb: (error?: Error | null) => void): void {
    this.push(null);
    cb();
  }
}

function closed(stream: EventEmitter): Promise<void> {
  return new Promise((resolve) => stream.on("close", () => resolve()));
}

async function main(): Promise<void> {
  ticks(4);
  const store = new Store();
  log.push("write " + store.write("a"));
  store.end("b");
  store.on("finish", () => log.push("store finish"));
  await closed(store);

  const source = new Readable({
    construct(cb: (error?: Error | null) => void) {
      log.push("source construct");
      process.nextTick(cb);
    },
    read() {
      log.push("source read");
      this.push("x");
      this.push(null);
    },
  });
  source.on("data", (c: Buffer) => log.push("source data " + c.toString()));
  await closed(source);

  const pair = new Pair();
  pair.on("data", (v: { got: string }) => log.push("pair data " + v.got));
  pair.write("p");
  pair.end();
  await closed(pair);

  const upper = new Transform({
    construct(cb: (error?: Error | null) => void) {
      log.push("upper construct");
      cb();
    },
    transform(c: Buffer, _e: string, cb: (error: Error | null, data?: Buffer) => void) {
      cb(null, Buffer.from(c.toString().toUpperCase()));
    },
  });
  upper.on("data", (c: Buffer) => log.push("upper " + c.toString()));
  upper.end("shout");
  await closed(upper);

  const failing = new Writable({
    construct(cb: (error?: Error | null) => void) {
      cb(new Error("no target"));
    },
    write(_c: Buffer, _e: string, cb: (error?: Error | null) => void) {
      cb();
    },
  });
  failing.on("error", (e: Error) => log.push("failing " + e.message));
  await closed(failing);

  const raced = new Writable({
    construct(cb: (error?: Error | null) => void) {
      setTimeout(() => cb(new Error("late")), 2);
    },
    write(_c: Buffer, _e: string, cb: (error?: Error | null) => void) {
      cb();
    },
    destroy(err: Error | null, cb: (error?: Error | null) => void) {
      log.push("raced destroy " + (err ? err.message : "none"));
      cb(err);
    },
  });
  raced.on("error", (e: Error) => log.push(`raced ${e.name} ${e.message}`));
  raced.destroy(new Error("early"));
  await closed(raced);

  const thrown = new Writable({
    construct() {
      throw new Error("thrown in construct");
    },
    write(_c: Buffer, _e: string, cb: (error?: Error | null) => void) {
      cb();
    },
  });
  thrown.on("error", (e: Error) => log.push("thrown " + e.message));
  await closed(thrown);

  const twice = new Writable({
    construct(cb: (error?: Error | null) => void) {
      cb();
      cb();
    },
    write(_c: Buffer, _e: string, cb: (error?: Error | null) => void) {
      cb();
    },
  });
  twice.on("error", (e: Error) => log.push("twice " + (e as NodeJS.ErrnoException).code));
  await closed(twice);
  console.log(log.join("\n"));
}
main();
