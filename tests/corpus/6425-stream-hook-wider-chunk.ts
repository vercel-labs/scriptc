// Stream hooks may declare a supertype of what Node passes: chunks typed
// Buffer | string still arrive as Buffers.
import { Transform, Writable } from "node:stream";

class LineSink extends Writable {
  private rest = "";
  readonly lines: string[] = [];
  _write(chunk: Buffer | string, encoding: BufferEncoding, cb: (err?: Error | null) => void): void {
    console.log("chunk", typeof chunk, Buffer.isBuffer(chunk), encoding);
    const parts = (this.rest + chunk.toString()).split("\n");
    this.rest = parts.pop() ?? "";
    this.lines.push(...parts);
    cb();
  }
  _final(cb: (err?: Error | null) => void): void {
    if (this.rest !== "") this.lines.push(this.rest);
    cb();
  }
}

class Upper extends Transform {
  _transform(chunk: string | Buffer, _enc: string, cb: (err?: Error | null, data?: string) => void): void {
    cb(null, chunk.toString().toUpperCase());
  }
}

class Failing extends Writable {
  _write(chunk: Uint8Array | string, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    cb(new Error(`refused ${chunk.toString().length} bytes`));
  }
}

const sink = new LineSink();
sink.write("a\nb");
sink.write(Buffer.from("c\nd"));
sink.end("e");
sink.on("finish", () => console.log("lines", JSON.stringify(sink.lines)));

const up = new Upper();
up.on("data", (d: Buffer) => console.log("upper", d.toString()));
up.write("hello ");
up.end("world");

const bad = new Failing();
bad.on("error", (e) => console.log("error", e.message));
bad.write("xyz");
