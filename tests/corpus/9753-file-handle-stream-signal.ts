// The streams of a FileHandle take `signal` like fs.createReadStream and
// fs.createWriteStream do: an abort destroys the stream with an AbortError
// and closes the handle (its fd reads -1), also when the signal was aborted
// before the stream existed. readLines passes its options to the read stream.
import { mkdtemp, open, readFile, writeFile } from "node:fs/promises";
import type { ReadStream, WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

function watchRead(stream: ReadStream, log: string[]): Promise<void> {
  stream.on("end", () => log.push("end"));
  stream.on("error", (error: Error) => log.push(`error ${shape(error)}`));
  return new Promise<void>((resolve) => {
    stream.on("close", () => {
      log.push("close");
      resolve();
    });
  });
}

function watchWrite(stream: WriteStream, log: string[]): Promise<void> {
  stream.on("finish", () => log.push("finish"));
  stream.on("error", (error: Error) => log.push(`error ${shape(error)}`));
  return new Promise<void>((resolve) => {
    stream.on("close", () => {
      log.push("close");
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "scr-fhs-"));
  const file = join(dir, "data.txt");
  await writeFile(file, "one\ntwo\nthree\nfour\n" + "x".repeat(6000));

  {
    const handle = await open(file, "r");
    const controller = new AbortController();
    const stream = handle.createReadStream({ signal: controller.signal });
    const log: string[] = [];
    let bytes = 0;
    stream.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
    });
    await watchRead(stream, log);
    controller.abort();
    console.log("read, never aborted:", log.join(" | "), "| bytes", bytes, "| fd", handle.fd);
  }
  {
    const handle = await open(file, "r");
    const stream = handle.createReadStream({ signal: AbortSignal.abort() });
    const log: string[] = [`destroyed ${stream.destroyed}`];
    stream.on("data", () => log.push("data"));
    await watchRead(stream, log);
    console.log("read, already aborted:", log.join(" | "), "| fd", handle.fd);
  }
  {
    const handle = await open(file, "r");
    const controller = new AbortController();
    const stream = handle.createReadStream({ signal: controller.signal, highWaterMark: 1000 });
    const log: string[] = [];
    let chunks = 0;
    stream.on("data", () => {
      if (++chunks === 2) controller.abort(new Error("stop"));
    });
    await watchRead(stream, log);
    console.log("read, aborted while reading:", log.join(" | "), "| chunks", chunks, "| fd", handle.fd);
  }
  {
    const handle = await open(file, "r");
    const controller = new AbortController();
    const lines: string[] = [];
    let caught = "nothing";
    try {
      for await (const line of handle.readLines({ signal: controller.signal, highWaterMark: 4 })) {
        lines.push(line);
        if (lines.length === 2) controller.abort();
      }
    } catch (error) {
      caught = shape(error);
    }
    console.log("readLines, aborted:", JSON.stringify(lines), "| caught", caught, "| fd", handle.fd);
  }
  {
    const path = join(dir, "written.txt");
    const handle = await open(path, "w");
    const controller = new AbortController();
    // @types/node leaves `signal` out of the write stream's options; Node
    // passes the options on to fs.WriteStream, which takes it.
    const stream = handle.createWriteStream({ signal: controller.signal } as { flush?: boolean });
    const log: string[] = [];
    const closed = watchWrite(stream, log);
    stream.write("kept", () => {
      log.push("write callback");
      controller.abort();
    });
    await closed;
    console.log("write, aborted after a write:", log.join(" | "), "| file", await readFile(path, "utf8"));
  }
  {
    const path = join(dir, "untouched.txt");
    const handle = await open(path, "w");
    const signal = AbortSignal.abort("no");
    const stream = handle.createWriteStream({ signal } as { flush?: boolean });
    const log: string[] = [`destroyed ${stream.destroyed}`];
    const closed = watchWrite(stream, log);
    stream.write("lost", (error) => log.push(`write callback ${shape(error)}`));
    await closed;
    console.log("write, already aborted:", log.join(" | "), "| fd", handle.fd);
  }
}

main();
