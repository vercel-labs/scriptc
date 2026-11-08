// A stream's abort listener goes when finished() would call back: at the end
// of a Readable or the finish of a Writable that does not destroy itself, and
// at the close of one that does. An abort after that point does nothing; an
// abort before it destroys the stream with an AbortError.
import { addAbortSignal, Readable, Writable } from "node:stream";

function tick(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

async function readableKeptOpen(): Promise<void> {
  const controller = new AbortController();
  const signal = controller.signal;
  const stream = new Readable({
    signal,
    autoDestroy: false,
    read() {
      this.push("chunk");
      this.push(null);
    },
  });
  const log: string[] = [];
  stream.on("error", (error: Error) => log.push(`error ${error.name}`));
  stream.on("close", () => log.push("close"));
  const ended = new Promise<void>((resolve) => stream.on("end", () => resolve()));
  stream.resume();
  await ended;
  await tick();
  controller.abort();
  await tick();
  console.log("readable, autoDestroy false, aborted after end:", log.join(" | "), "| destroyed", stream.destroyed);
}

async function writableKeptOpen(): Promise<void> {
  const controller = new AbortController();
  const signal = controller.signal;
  const stream = new Writable({
    signal,
    autoDestroy: false,
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const log: string[] = [];
  stream.on("error", (error: Error) => log.push(`error ${error.name}`));
  stream.on("close", () => log.push("close"));
  const finished = new Promise<void>((resolve) => stream.on("finish", () => resolve()));
  stream.end("data");
  await finished;
  await tick();
  controller.abort();
  await tick();
  console.log("writable, autoDestroy false, aborted after finish:", log.join(" | "), "| destroyed", stream.destroyed);
}

async function readableBeforeEnd(): Promise<void> {
  const controller = new AbortController();
  const signal = controller.signal;
  const stream = new Readable({ signal, autoDestroy: false, read() {} });
  const log: string[] = [];
  stream.on("error", (error: Error) => log.push(`error ${error.name}`));
  const closed = new Promise<void>((resolve) => stream.on("close", () => resolve()));
  stream.resume();
  await tick();
  controller.abort();
  await closed;
  console.log("readable, autoDestroy false, aborted before end:", log.join(" | "), "| destroyed", stream.destroyed);
}

async function addedLater(): Promise<void> {
  const controller = new AbortController();
  const stream = new Readable({
    autoDestroy: false,
    read() {
      this.push(null);
    },
  });
  addAbortSignal(controller.signal, stream);
  const log: string[] = [];
  stream.on("error", (error: Error) => log.push(`error ${error.name}`));
  stream.on("close", () => log.push("close"));
  const ended = new Promise<void>((resolve) => stream.on("end", () => resolve()));
  stream.resume();
  await ended;
  await tick();
  controller.abort();
  await tick();
  console.log("addAbortSignal, autoDestroy false, aborted after end:", log.join(" | "), "| destroyed", stream.destroyed);
}

async function selfDestroying(): Promise<void> {
  const controller = new AbortController();
  const signal = controller.signal;
  const stream = new Readable({
    signal,
    read() {
      this.push(null);
    },
  });
  const log: string[] = [];
  stream.on("error", (error: Error) => log.push(`error ${error.name}`));
  const closed = new Promise<void>((resolve) => stream.on("close", () => resolve()));
  stream.resume();
  await closed;
  controller.abort();
  await tick();
  console.log("readable, aborted after close:", log.join(" | "), "| errored", stream.errored);
}

async function main(): Promise<void> {
  await readableKeptOpen();
  await writableKeptOpen();
  await readableBeforeEnd();
  await addedLater();
  await selfDestroying();
}

main();
