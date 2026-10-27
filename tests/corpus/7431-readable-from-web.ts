// Readable.fromWeb in typed code: a ReadableStream<Uint8Array> read as
// Buffers, a ReadableStream<string> in object mode with a highWaterMark of
// 1, and an AbortSignal that destroys the Readable and cancels the stream.
import { Readable } from "node:stream";

const log: string[] = [];

async function main(): Promise<void> {
  const bytes = new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(new TextEncoder().encode("web"));
      controller.enqueue(new TextEncoder().encode("bytes"));
      controller.close();
    },
  });
  const r = Readable.fromWeb(bytes);
  for await (const chunk of r) log.push(`bytes ${Buffer.isBuffer(chunk)} ${String(chunk)}`);
  const words = new ReadableStream<string>({
    start(controller): void {
      controller.enqueue("alpha");
      controller.enqueue("beta");
      controller.close();
    },
  });
  const o = Readable.fromWeb(words, { objectMode: true, highWaterMark: 1 });
  log.push(`object mode ${o.readableObjectMode} ${o.readableHighWaterMark}`);
  for await (const word of o) log.push(`word ${String(word)}`);
  const ac = new AbortController();
  const signal = ac.signal;
  let n = 0;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller): void {
      controller.enqueue(new Uint8Array([++n]));
    },
    cancel(reason: unknown): void {
      log.push(`cancelled ${(reason as Error).name}`);
    },
  });
  const a = Readable.fromWeb(endless, { signal });
  a.on("error", (e: Error) => log.push(`aborted ${e.name}`));
  a.once("data", () => ac.abort());
  await new Promise<void>((resolve) => a.on("close", () => resolve()));
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  for (const line of log) console.log(line);
}

void main();
