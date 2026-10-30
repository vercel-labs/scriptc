// Typed writev on Transform and PassThrough: an options writev with
// decodeStrings: false and flush, a Transform subclass's _writev, a
// batch completing with an error, and object-mode entries whose
// encoding is declared as a string or as Node's string | null |
// undefined.
import { Transform, PassThrough, Writable } from "node:stream";
type WritevChunks = Array<{ chunk: any; encoding: BufferEncoding }>;
type Cb = (error?: Error | null) => void;
type TransformCallback = (error?: Error | null, data?: any) => void;
const log: string[] = [];
const t = new Transform({
  decodeStrings: false,
  transform(chunk: string, enc: BufferEncoding, cb: TransformCallback): void {
    log.push(`transform ${chunk} ${enc}`);
    cb(null, chunk);
  },
  flush(cb: TransformCallback): void {
    log.push("flush");
    cb(null, "!");
  },
  writev(chunks: WritevChunks, cb: Cb): void {
    log.push(`writev ${chunks.map((c) => `${c.chunk}/${c.encoding}`).join(",")}`);
    this.push(chunks.map((c) => String(c.chunk)).join(""));
    cb();
  },
});
t.on("data", (d: Buffer) => log.push(`data ${d.toString()}`));
t.on("end", () => log.push("end"));
t.on("finish", () => log.push("finish"));
t.on("close", () => {
  console.log(log.join("\n"));
  next();
});
t.write("one");
t.cork();
t.write("two", "latin1");
t.write("three");
t.uncork();
t.end("four");

class Batcher extends Transform {
  _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    console.log("batcher transform", chunk.toString());
    cb(null, chunk);
  }
  _writev(chunks: Array<{ chunk: any; encoding: BufferEncoding }>, cb: Cb): void {
    console.log("batcher writev", chunks.length);
    this.push(Buffer.concat(chunks.map((c) => c.chunk as Buffer)));
    cb();
  }
}

function next(): void {
  const b = new Batcher();
  b.on("data", (d: Buffer) => console.log("batcher data", d.toString()));
  b.write("x");
  b.cork();
  b.write("y");
  b.write("z");
  process.nextTick(() => {
    b.uncork();
    b.end();
  });
  b.on("finish", () => {
    const p = new PassThrough({
      writev(chunks: WritevChunks, cb: Cb): void {
        console.log("pt writev", chunks.length, String(chunks[0]!.chunk));
        cb(new Error("batch failed"));
      },
    });
    p.on("error", (e: Error) => {
      console.log("pt error", e.message);
      objectEntries();
    });
    p.cork();
    p.write("1");
    p.write("2");
    p.uncork();
  });
}

function objectEntries(): void {
  const declared = new Writable({
    objectMode: true,
    write(_chunk: any, _enc: BufferEncoding, cb: Cb): void { cb(); },
    writev(chunks: WritevChunks, cb: Cb): void {
      console.log("string encodings", JSON.stringify(chunks.map((c) => c.chunk)));
      cb();
    },
  });
  declared.write({ n: 0 });
  declared.cork();
  declared.write({ n: 1 });
  declared.write({ n: 2 }, () => {});
  declared.uncork();
  const nodeTyped = new Writable({
    objectMode: true,
    write(_chunk: any, _enc: BufferEncoding, cb: Cb): void { cb(); },
    writev(chunks: Array<{ chunk: any; encoding: string | null | undefined }>, cb: Cb): void {
      console.log("node encodings", JSON.stringify(chunks.map((c) => [c.chunk, c.encoding === undefined ? "undefined" : c.encoding])));
      cb();
    },
  });
  nodeTyped.write({ n: 0 });
  nodeTyped.cork();
  nodeTyped.write({ n: 1 });
  nodeTyped.write({ n: 2 }, () => {});
  nodeTyped.uncork();
}
