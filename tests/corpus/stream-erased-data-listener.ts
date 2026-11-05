// A compiled Readable's 'data' emission carries its chunk to a listener
// registered through an untyped value, and 'pipe'/'unpipe' reach such a
// listener with a view of the stream. Node is the oracle.
import { Readable, Writable } from "node:stream";

class Source extends Readable {
  _read(): void {}
  feed(parts: (string | Buffer)[]): void {
    for (const part of parts) this.push(part);
    this.push(null);
  }
}

const chunks: string[] = [];
const source = new Source();
const anySource: any = source;
anySource.on("data", (chunk: any) => {
  chunks.push(String(chunk));
});
anySource.on("end", () => {
  console.log(chunks.join(","));
});
source.feed(["one", Buffer.from("two")]);

class Sink extends Writable {
  _write(chunk: string | Buffer, enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    cb();
  }
}
const src = new Source();
const dst = new Sink();
const anyDst: any = dst;
anyDst.on("pipe", (s: any) => {
  console.log(`pipe ${typeof s.pipe} ${s.readable}`);
});
anyDst.on("unpipe", () => {
  console.log("unpipe");
});
src.pipe(dst);
src.unpipe(dst);
