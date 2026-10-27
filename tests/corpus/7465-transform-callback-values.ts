// A transform or flush callback passing a value that is not a Buffer or a
// string: the push reports Node's ERR_INVALID_ARG_TYPE through 'error'
// and destroys the stream, for option callbacks and _transform methods,
// while Buffer and string values take the typed path.
import { Transform } from "node:stream";
type TransformCallback = (error?: Error | null, data?: any) => void;
const t = new Transform({
  transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    console.log("transform", chunk.toString());
    cb(null, 42);
  },
});
t.on("error", (e: Error & { code?: string }) => console.log("error", e.name, e.code, e.message));
t.on("data", (d: Buffer) => console.log("data", d.toString()));
t.on("close", () => console.log("close", t.destroyed));
console.log("write", t.write("a"));
const f = new Transform({
  transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void { cb(null, chunk); },
  flush(cb: TransformCallback): void { cb(null, { tail: true }); },
});
f.on("error", (e: Error & { code?: string }) => console.log("flush error", e.code, e.message));
f.on("data", (d: Buffer) => console.log("flush data", d.toString()));
f.on("close", () => console.log("flush close"));
f.end("z");
class Bad extends Transform {
  _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    cb(null, chunk.length);
  }
}
const bad = new Bad();
bad.on("error", (e: Error & { code?: string }) => console.log("error", e.code, e.message));
bad.on("close", () => console.log("close"));
bad.write("abc");
class Good extends Transform {
  _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    cb(null, chunk.toString().toUpperCase());
  }
}
const good = new Good();
good.on("data", (d: Buffer) => console.log("good", d.toString()));
good.end("xyz");
