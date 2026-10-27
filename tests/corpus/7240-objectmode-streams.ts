// Typed object-mode streams: records through Readable.from, Transform
// and Writable in pipeline(), typed 'data' listeners, a Transform with
// readableObjectMode parsing bytes into records, an object-mode Duplex,
// a PassThrough's object-counted high-water mark, and Readable.from over
// a Map, a Set of records and an array mixing strings and Buffers, and
// byte-mode chunk parameters typed Buffer | string.
import { Duplex, PassThrough, Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

interface Row {
  id: number;
  name: string;
}

interface Total {
  count: number;
  ids: number[];
}

async function records(): Promise<void> {
  const source = Readable.from([
    { id: 1, name: "ada" },
    { id: 2, name: "bo" },
    { id: 3, name: "cy" },
  ]);
  const shout = new Transform({
    objectMode: true,
    transform(row: Row, _enc: string, cb: (err: Error | null, out?: Row) => void) {
      if (row.id === 2) {
        cb(null);
        return;
      }
      cb(null, { id: row.id * 10, name: row.name.toUpperCase() });
    },
  });
  const seen: Row[] = [];
  await pipeline(
    source,
    shout,
    new Writable({
      objectMode: true,
      write(row: Row, enc: string | null | undefined, cb: () => void) {
        seen.push(row);
        console.log("write", row.id, enc);
        cb();
      },
    }),
  );
  console.log(seen.map((r) => `${r.id}:${r.name}`).join(" "));
}

function counters(): void {
  const counter = new Readable({ objectMode: true, read() {} });
  console.log("hwm", counter.readableHighWaterMark, counter.readableObjectMode);
  counter.on("data", (n: number) => console.log("data", n + 1));
  counter.on("end", () => console.log("counter end"));
  counter.push(1);
  counter.push(0);
  counter.push(41);
  counter.push(null);
}

function sided(): void {
  // bytes in, records out
  const parse = new Transform({
    readableObjectMode: true,
    transform(chunk: Buffer, _enc: string, cb: (err: Error | null, out?: Total) => void) {
      const ids = chunk.toString().split(",").map((s) => Number(s));
      cb(null, { count: ids.length, ids });
    },
  });
  console.log(
    "sided",
    parse.readableObjectMode,
    parse.writableObjectMode,
    parse.readableHighWaterMark,
    parse.writableHighWaterMark,
  );
  parse.on("data", (t: Total) => console.log("total", t.count, t.ids.join("+")));
  parse.write("1,2,3");
  parse.end("4");
}

function duplex(): void {
  const echo = new Duplex({
    objectMode: true,
    read() {},
    write(chunk: Row, _enc: string, cb: () => void) {
      this.push({ id: chunk.id + 1, name: chunk.name });
      cb();
    },
    final(cb: () => void) {
      this.push(null);
      cb();
    },
  });
  echo.on("data", (r: Row) => console.log("echo", r.id, r.name));
  echo.write({ id: 1, name: "x" });
  echo.end({ id: 5, name: "y" });
}

function passthrough(): void {
  const pt = new PassThrough({ objectMode: true, highWaterMark: 2 });
  const ok1 = pt.write({ id: 1, name: "a" });
  const ok2 = pt.write({ id: 2, name: "b" });
  console.log("backpressure", ok1, ok2, pt.writableLength, pt.readableLength);
  pt.on("data", (r: Row) => console.log("pt", r.name));
  pt.end();
}

async function collections(): Promise<void> {
  const prices = new Map<string, number>([
    ["tea", 3],
    ["cake", 5],
  ]);
  for await (const entry of Readable.from(prices)) console.log("entry", JSON.stringify(entry));
  const mixed: (string | Buffer)[] = ["text", Buffer.from("bytes")];
  for await (const chunk of Readable.from(mixed)) console.log("mixed", typeof chunk, String(chunk));
  const tags = new Set([{ tag: "a" }, { tag: "b" }]);
  for await (const t of Readable.from(tags)) console.log("set", JSON.stringify(t));
}

// Byte-mode sides pass Buffers: a chunk parameter typed as a supertype
// of Buffer takes them, inline and as an underscore method, and
// super(undefined) leaves the stream in byte mode.
class Collector extends Writable {
  constructor() {
    super(undefined);
  }
  _write(chunk: Buffer | string, _encoding: BufferEncoding, cb: (err?: Error | null) => void): void {
    console.log("collector", Buffer.isBuffer(chunk), typeof chunk === "string" ? chunk : chunk.toString());
    cb();
  }
}

async function byteChunks(): Promise<void> {
  const inline = new Writable({
    write(chunk: Buffer | string, _encoding: BufferEncoding, cb: (err?: Error | null) => void): void {
      console.log("inline", Buffer.isBuffer(chunk), typeof chunk === "string" ? chunk : chunk.toString());
      cb();
    },
  });
  inline.write("one");
  inline.end(Buffer.from("two"));
  await new Promise<void>((resolve) => inline.on("finish", () => resolve()));
  const collector = new Collector();
  collector.end("three");
  await new Promise<void>((resolve) => collector.on("finish", () => resolve()));
}

async function main(): Promise<void> {
  await records();
  await collections();
  counters();
  sided();
  duplex();
  passthrough();
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  await byteChunks();
}
main();
