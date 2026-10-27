// Transform option callbacks whose completion callback declares an
// any-typed `data` (the @types/node TransformCallback spelling): the data
// passed back may be a Buffer, a string, or omitted.
import { PassThrough, Transform } from "node:stream";
import { createGunzip, gzipSync } from "node:zlib";

type Done = (error?: Error | null, data?: any) => void;

interface Progress {
  bytes: number;
  chunks: number;
}

function counting(progress: Progress): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding: string, callback: Done) {
      progress.bytes += chunk.length;
      progress.chunks++;
      callback(null, chunk);
    },
  });
}

const upper = new Transform({
  transform(chunk: Buffer, _encoding: string, callback: Done) {
    const text = chunk.toString();
    if (text === "skip") {
      callback();
      return;
    }
    callback(null, text.toUpperCase());
  },
  flush(callback: Done) {
    callback(null, Buffer.from("!"));
  },
});
upper.on("data", (d: Buffer) => console.log("upper", JSON.stringify(d.toString())));
upper.on("end", () => console.log("upper end"));
upper.write("hello");
upper.write("skip");
upper.end("world");

const failing = new Transform({
  transform(chunk: Buffer, _encoding: string, callback: Done) {
    callback(new Error(`refused ${chunk.length} bytes`));
  },
});
failing.on("error", (e: Error) => console.log("error", e.message));
failing.write("abc");

const progress: Progress = { bytes: 0, chunks: 0 };
const counter = counting(progress);
const out = new PassThrough();
counter.pipe(createGunzip()).pipe(out);
const parts: string[] = [];
out.on("data", (d: Buffer) => parts.push(d.toString()));
out.on("end", () => {
  console.log("gunzip", JSON.stringify(parts.join("")), progress.bytes > 0, progress.chunks);
});
counter.end(gzipSync(Buffer.from("compressed payload")));
