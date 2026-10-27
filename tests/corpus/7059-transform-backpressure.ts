// Transform write backpressure and typed pipeline stages. A Transform
// holds a write's callback while its readable side is at the high-water
// mark, so write() returns false once both buffers fill and 'drain' comes
// after the reader catches up. Typed stages: named async generator
// functions on both sides of zlib streams, an array source, and an async
// function destination whose value resolves the promise pipeline.
import { PassThrough, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";

class Copy extends Transform {
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.push(chunk);
    cb();
  }
}

async function measure(label: string, t: Transform): Promise<void> {
  let received = 0;
  const slow = new Writable({
    highWaterMark: 1024,
    write(chunk: Buffer, _enc: string, cb: () => void) {
      received += chunk.length;
      setImmediate(cb);
    },
  });
  t.pipe(slow);
  const block = Buffer.alloc(4096, 120);
  let falseAt = -1;
  for (let i = 1; i <= 64; i++) {
    if (!t.write(block)) {
      falseAt = i;
      break;
    }
  }
  console.log(label, "write() false at", falseAt, t.writableLength, t.readableLength);
  await new Promise<void>((resolve) => t.once("drain", () => resolve()));
  console.log(label, "drained", t.writableLength);
  await new Promise<void>((resolve) => {
    slow.on("finish", () => resolve());
    t.end();
  });
  console.log(label, "received", received);
}

async function* numbered(): AsyncGenerator<string> {
  for (let i = 0; i < 4; i++) yield `row ${i}\n`;
}

async function* shout(source: AsyncIterable<Buffer>): AsyncGenerator<string> {
  for await (const chunk of source) yield chunk.toString().toUpperCase();
}

async function count(source: AsyncIterable<string>): Promise<number> {
  let n = 0;
  for await (const chunk of source) n += chunk.split("\n").length - 1;
  return n;
}

async function main(): Promise<void> {
  await measure("passthrough", new PassThrough());
  await measure("subclass", new Copy());
  await measure(
    "options",
    new Transform({
      transform(chunk: Buffer, _enc: string, cb: (err?: Error | null, data?: Buffer) => void) {
        cb(null, chunk);
      },
    }),
  );

  const out: string[] = [];
  await pipeline(
    numbered,
    zlib.createGzip(),
    zlib.createGunzip(),
    shout,
    new Writable({
      write(chunk: Buffer, _enc: string, cb: () => void) {
        out.push(chunk.toString());
        cb();
      },
    }),
  );
  console.log("named stages:", JSON.stringify(out.join("")));

  const rows = await pipeline(["a\n", "b\n", "c\n"], zlib.createGzip(), zlib.createGunzip(), shout, count);
  console.log("array source, rows:", rows);
}
main();
