// A plain { readable, writable } pair of web streams as a pipeline stage,
// written with its static record type: the pipeline pumps the pair's web
// sides with the chunks untouched, so numeric chunks reach the next stage
// as numbers.
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

const double = new TransformStream<number, number>({
  transform(chunk, controller) {
    controller.enqueue(chunk * 2);
  },
});
const pair = { readable: double.readable, writable: double.writable };

const out: string[] = [];
const writable = new Writable({
  objectMode: true,
  write(chunk: number, _encoding: string, callback: (error?: Error | null) => void) {
    out.push(`${typeof chunk}:${JSON.stringify(chunk)}`);
    callback();
  },
});

await pipeline(Readable.from([1, 2, 3]), pair, writable);
console.log("typed pair", out.join(","));
