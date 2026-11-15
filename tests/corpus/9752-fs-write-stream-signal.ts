// fs.createWriteStream(path, { signal }): the stream is destroyed with an
// AbortError when the signal aborts. Each case prints the stream's events
// and write callbacks in order, by when the abort happens, and what the
// file holds afterwards.
import {
  closeSync,
  createWriteStream,
  existsSync,
  fstatSync,
  mkdtempSync,
  readFileSync,
  type WriteStream,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "scr-wss-"));

function shape(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (!(value instanceof Error)) return `${typeof value} ${String(value)}`;
  const code = (value as NodeJS.ErrnoException).code;
  const cause = value.cause;
  const tail =
    cause === undefined
      ? "no cause"
      : cause instanceof Error
        ? `cause ${cause.name}: ${cause.message}`
        : `cause ${typeof cause} ${String(cause)}`;
  return `${value.name} ${code} "${value.message}" ${tail}`;
}

function events(stream: WriteStream, log: string[], last: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (name: string): void => {
      if (name === last) resolve();
    };
    stream.on("open", (fd: number) => {
      log.push(`open ${fd >= 0}`);
      done("open");
    });
    stream.on("ready", () => {
      log.push("ready");
      done("ready");
    });
    stream.on("finish", () => {
      log.push("finish");
      done("finish");
    });
    stream.on("error", (error: Error) => {
      log.push(`error ${shape(error)}`);
      done("error");
    });
    stream.on("close", () => {
      log.push("close");
      done("close");
    });
  });
}

function isOpen(fd: number): boolean {
  try {
    fstatSync(fd);
    return true;
  } catch {
    return false;
  }
}

function content(path: string): string {
  return existsSync(path) ? JSON.stringify(readFileSync(path, "utf8")) : "no file";
}

async function neverAborted(): Promise<void> {
  const path = join(dir, "never.txt");
  const controller = new AbortController();
  const stream = createWriteStream(path, { signal: controller.signal });
  const log: string[] = [];
  const closed = events(stream, log, "close");
  stream.write("hello ");
  stream.end("world");
  await closed;
  controller.abort();
  console.log("never aborted:", log.join(" | "), "| file", content(path), "| errored", stream.errored);
}

async function alreadyAborted(): Promise<void> {
  const path = join(dir, "early.txt");
  const stream = createWriteStream(path, { signal: AbortSignal.abort() });
  const log: string[] = [`destroyed ${stream.destroyed}`];
  let fd = -1;
  stream.on("open", (opened: number) => {
    fd = opened;
  });
  const ready = events(stream, log, "ready");
  stream.write("lost", (error) => log.push(`write callback ${shape(error)}`));
  // As for a read stream, the file is still opened (and so created) after
  // the stream was destroyed, and its descriptor stays with the program.
  await ready;
  log.push(`descriptor open ${isOpen(fd)}`);
  closeSync(fd);
  console.log("already aborted:", log.join(" | "), "| file", content(path));
}

async function abortedBeforeOpen(): Promise<void> {
  const path = join(dir, "before-open.txt");
  const controller = new AbortController();
  const stream = createWriteStream(path, { signal: controller.signal });
  const log: string[] = [];
  let fd = -1;
  stream.on("open", (opened: number) => {
    fd = opened;
  });
  const closed = events(stream, log, "close");
  stream.write("lost", (error) => log.push(`write callback ${shape(error)}`));
  controller.abort(new Error("changed my mind"));
  await closed;
  console.log(
    "aborted before open:",
    log.join(" | "),
    "| descriptor open",
    isOpen(fd),
    "| file",
    content(path),
  );
}

async function abortedAfterWrite(): Promise<void> {
  const path = join(dir, "after-write.txt");
  const controller = new AbortController();
  const stream = createWriteStream(path, { signal: controller.signal });
  const log: string[] = [];
  let fd = -1;
  stream.on("open", (opened: number) => {
    fd = opened;
  });
  const closed = events(stream, log, "close");
  stream.write("kept", () => {
    log.push("write callback");
    controller.abort();
  });
  await closed;
  await new Promise<void>((resolve) => {
    stream.write("late", (error) => {
      log.push(`late write callback ${shape(error)}`);
      resolve();
    });
  });
  console.log(
    "aborted after a write:",
    log.join(" | "),
    "| bytesWritten",
    stream.bytesWritten,
    "| descriptor open",
    isOpen(fd),
    "| file",
    content(path),
  );
}

async function abortedAfterFinish(): Promise<void> {
  const path = join(dir, "after-finish.txt");
  const controller = new AbortController();
  const stream = createWriteStream(path, { signal: controller.signal, autoClose: false });
  const log: string[] = [];
  let fd = -1;
  stream.on("open", (opened: number) => {
    fd = opened;
  });
  const finished = events(stream, log, "finish");
  stream.end("done");
  await finished;
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await new Promise<void>((resolve) => setImmediate(resolve));
  log.push(`destroyed ${stream.destroyed}`, `descriptor open ${isOpen(fd)}`);
  const closed = new Promise<void>((resolve) => stream.on("close", () => resolve()));
  stream.destroy();
  await closed;
  console.log("aborted after finish:", log.join(" | "), "| file", content(path));
}

function invalidSignals(): void {
  // getOptions checks the signal before anything else about the stream, so
  // nothing is created; only `undefined` means "no signal".
  const path = join(dir, "invalid.txt");
  const values: unknown[] = [null, 5, "signal", false, {}, [], undefined];
  for (const value of values) {
    const options: { encoding: string; signal: unknown } = { encoding: "buffer", signal: value };
    try {
      createWriteStream(path, options as never);
      console.log("invalid signal", String(value), "accepted");
    } catch (error) {
      console.log("invalid signal:", shape(error));
    }
  }
  console.log("invalid signals leave", content(path));
}

async function main(): Promise<void> {
  await neverAborted();
  await alreadyAborted();
  await abortedBeforeOpen();
  await abortedAfterWrite();
  await abortedAfterFinish();
  invalidSignals();
}

main();
