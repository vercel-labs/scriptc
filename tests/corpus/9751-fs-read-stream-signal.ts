// fs.createReadStream(path, { signal }): the stream is destroyed with an
// AbortError when the signal aborts, as stream.addAbortSignal does. Each
// case prints the stream's events in order, by when the abort happens: never,
// before the stream exists, before the file is open, at 'open', while
// reading, in a for await loop, and after the end.
import {
  closeSync,
  createReadStream,
  fstatSync,
  mkdtempSync,
  openSync,
  type ReadStream,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "scr-rss-"));
const file = join(dir, "data.txt");
writeFileSync(file, "0123456789".repeat(1000));

function shape(value: unknown): string {
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

/** The stream's events in order; resolves at `last`. */
function events(stream: ReadStream, log: string[], last: string): Promise<void> {
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
    stream.on("end", () => {
      log.push("end");
      done("end");
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

async function neverAborted(): Promise<void> {
  const controller = new AbortController();
  const stream = createReadStream(file, { signal: controller.signal });
  const log: string[] = [];
  let bytes = 0;
  stream.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
  });
  await events(stream, log, "close");
  // The stream has closed: its abort listener is gone, so this does nothing.
  controller.abort();
  console.log("never aborted:", log.join(" | "), "| bytes", bytes, "| errored", stream.errored);
}

async function alreadyAborted(label: string, signal: AbortSignal): Promise<void> {
  const stream = createReadStream(file, { signal });
  const log: string[] = [`destroyed ${stream.destroyed}`, `pending ${stream.pending}`];
  let fd = -1;
  stream.on("open", (opened: number) => {
    fd = opened;
  });
  stream.on("data", () => log.push("data"));
  // Node destroys the stream in its constructor and still opens the file
  // afterwards: 'open' and 'ready' follow 'close', and the descriptor stays
  // with the program.
  await events(stream, log, "ready");
  log.push(`pending ${stream.pending}`, `descriptor open ${isOpen(fd)}`);
  closeSync(fd);
  console.log(`${label}:`, log.join(" | "));
}

async function abortedBeforeOpen(): Promise<void> {
  const controller = new AbortController();
  const stream = createReadStream(file, { signal: controller.signal });
  const log: string[] = [];
  let fd = -1;
  stream.on("open", (opened: number) => {
    fd = opened;
  });
  const closed = events(stream, log, "close");
  controller.abort();
  log.push(`destroyed ${stream.destroyed}`);
  await closed;
  console.log("aborted before open:", log.join(" | "), "| descriptor open", isOpen(fd));
}

async function abortedAtOpen(): Promise<void> {
  const controller = new AbortController();
  const stream = createReadStream(file, { signal: controller.signal });
  const log: string[] = [];
  let fd = -1;
  stream.on("open", (opened: number) => {
    fd = opened;
    controller.abort(new RangeError("stop at open"));
  });
  stream.on("data", () => log.push("data"));
  await events(stream, log, "close");
  console.log("aborted at open:", log.join(" | "), "| descriptor open", isOpen(fd));
}

async function abortedWhileReading(): Promise<void> {
  const controller = new AbortController();
  const stream = createReadStream(file, { signal: controller.signal, highWaterMark: 1000 });
  const log: string[] = [];
  let fd = -1;
  let chunks = 0;
  stream.on("open", (opened: number) => {
    fd = opened;
  });
  stream.on("data", () => {
    if (++chunks === 3) {
      controller.abort("enough");
      log.push(`aborted, destroyed ${stream.destroyed}`);
    }
  });
  await events(stream, log, "close");
  console.log(
    "aborted while reading:",
    log.join(" | "),
    "| chunks",
    chunks,
    "| bytesRead",
    stream.bytesRead,
    "| descriptor open",
    isOpen(fd),
  );
}

async function abortedInForAwait(): Promise<void> {
  const controller = new AbortController();
  const stream = createReadStream(file, {
    encoding: "utf8",
    signal: controller.signal,
    highWaterMark: 2500,
  });
  let chunks = 0;
  let caught = "nothing";
  try {
    for await (const chunk of stream) {
      if (chunk.length > 0 && ++chunks === 2) controller.abort();
    }
  } catch (error) {
    caught = shape(error);
  }
  console.log("aborted in for await: chunks", chunks, "| caught", caught);
}

async function abortedAfterEnd(): Promise<void> {
  const controller = new AbortController();
  const stream = createReadStream(file, { signal: controller.signal, autoClose: false });
  const log: string[] = [];
  let fd = -1;
  stream.on("open", (opened: number) => {
    fd = opened;
  });
  stream.resume();
  await events(stream, log, "end");
  // The stream ended and is not destroyed (autoClose is false): the abort
  // listener went with the end, so the stream stays as it is.
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await new Promise<void>((resolve) => setImmediate(resolve));
  log.push(`destroyed ${stream.destroyed}`, `descriptor open ${isOpen(fd)}`);
  const closed = new Promise<void>((resolve) => stream.on("close", () => resolve()));
  stream.destroy();
  await closed;
  console.log("aborted after end:", log.join(" | "), "| then descriptor open", isOpen(fd));
}

async function descriptorGiven(): Promise<void> {
  // A descriptor the stream was given is closed by the abort, also when the
  // signal was aborted before the stream existed.
  const first = openSync(file, "r");
  const early = createReadStream("", { fd: first, signal: AbortSignal.abort() });
  const earlyLog: string[] = [];
  await events(early, earlyLog, "close");
  console.log("descriptor, already aborted:", earlyLog.join(" | "), "| open", isOpen(first));

  const second = openSync(file, "r");
  const controller = new AbortController();
  const late = createReadStream("", { fd: second, signal: controller.signal, highWaterMark: 4000 });
  const lateLog: string[] = [];
  late.once("data", () => controller.abort());
  await events(late, lateLog, "close");
  console.log("descriptor, aborted while reading:", lateLog.join(" | "), "| open", isOpen(second));
}

async function missingFile(): Promise<void> {
  // The open fails after the abort: Node reports both as one AggregateError
  // that carries the abort's message and code.
  const controller = new AbortController();
  const stream = createReadStream(join(dir, "missing.txt"), { signal: controller.signal });
  const log: string[] = [];
  let parts = "";
  stream.on("error", (error: Error) => {
    if (error instanceof AggregateError) {
      parts = error.errors
        .map((part: unknown) =>
          part instanceof Error ? `${part.name} ${(part as NodeJS.ErrnoException).code}` : "?",
        )
        .join(", ");
    }
  });
  const closed = events(stream, log, "close");
  controller.abort();
  await closed;
  console.log("missing file, aborted before open:", log.join(" | "), "| errors", parts);

  const early = createReadStream(join(dir, "missing.txt"), { signal: AbortSignal.abort() });
  const earlyLog: string[] = [];
  await events(early, earlyLog, "close");
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  console.log("missing file, already aborted:", earlyLog.join(" | "));
}

async function main(): Promise<void> {
  await neverAborted();
  await alreadyAborted("already aborted", AbortSignal.abort());
  await alreadyAborted("already aborted, an Error reason", AbortSignal.abort(new Error("why")));
  await alreadyAborted("already aborted, a string reason", AbortSignal.abort("text"));
  await abortedBeforeOpen();
  await abortedAtOpen();
  await abortedWhileReading();
  await abortedInForAwait();
  await abortedAfterEnd();
  await descriptorGiven();
  await missingFile();
  // A stream that still waits for its signal when the program ends.
  const waiting = createReadStream(file, { signal: new AbortController().signal });
  waiting.on("open", () => console.log("still waiting at exit: open, destroyed", waiting.destroyed));
}

main();
