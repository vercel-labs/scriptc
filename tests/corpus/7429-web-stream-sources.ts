// Web ReadableStreams as sources in typed code: Readable.from over a
// ReadableStream<string>, interleaved with nextTick callbacks, and a
// ReadableStream<Uint8Array> heading compose() into an async generator.
import { Readable, compose } from "node:stream";

const log: string[] = [];

function words(): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller): void {
      controller.enqueue("typed");
      controller.enqueue("web");
      controller.close();
    },
  });
}

async function main(): Promise<void> {
  let n = 0;
  const tick = (): void => {
    log.push(`tick ${n}`);
    if (++n < 4) process.nextTick(tick);
  };
  process.nextTick(tick);
  const r = Readable.from(words());
  log.push(`object mode ${r.readableObjectMode}`);
  for await (const c of r) log.push(`word ${String(c)}`);
  const bytes = new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(new TextEncoder().encode("ab"));
      controller.enqueue(new TextEncoder().encode("cd"));
      controller.close();
    },
  });
  const lengths = compose(bytes, async function* (source: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
    for await (const chunk of source) yield `${chunk.length}`;
  });
  log.push(`lengths ${(await lengths.toArray()).join(",")}`);
  for (const line of log) console.log(line);
}

void main();
