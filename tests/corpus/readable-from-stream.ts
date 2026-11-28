// Readable.from(stream) with the stream's static type: a fresh object-mode
// stream (highWaterMark 1) over the source's chunks.
import { PassThrough, Readable } from "node:stream";

const inner = new PassThrough();
const wrapped: Readable = Readable.from(inner);
console.log("typed", wrapped.readableObjectMode, wrapped.readableHighWaterMark, wrapped === inner);

const out: string[] = [];
wrapped.on("data", (chunk: Buffer | string) =>
  out.push(Buffer.isBuffer(chunk) ? chunk.toString() : chunk),
);
const ended = new Promise<void>((resolve, reject) => {
  wrapped.on("end", resolve);
  wrapped.on("error", reject);
});
inner.write("hi");
inner.end("!");
await ended;
console.log("typed chunks", out.join(","));

// The encoding initializer evaluates before the source's iterator opens: a
// throwing one leaves the stream untouched.
const refuse = (): "hex" => {
  throw new Error("refused");
};
const untouched = new PassThrough();
try {
  Readable.from(untouched, { encoding: refuse() });
  console.log("stream refused missed");
} catch (error) {
  console.log(
    `stream refused ${(error as Error).message} ${untouched.destroyed} ${untouched.readableFlowing}`,
  );
}
