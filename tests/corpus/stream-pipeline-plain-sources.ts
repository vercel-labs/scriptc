// pipeline() plain function sources in typed code: the source function is
// called with { signal } while the pipeline is set up and answers a
// readable stream, which the pipeline reads; a typed stage and a typed
// destination follow it.
import { PassThrough, Readable, Writable, pipeline } from "node:stream";
import { pipeline as pipelinePromise } from "node:stream/promises";

function sink(into: string[]): Writable {
  return new Writable({
    objectMode: true,
    write(chunk, _enc, cb) {
      into.push(String(chunk));
      cb();
    },
  });
}

const upper = (source: Readable): AsyncIterable<string> =>
  (async function* () {
    for await (const chunk of source) yield String(chunk).toUpperCase();
  })();

async function main(): Promise<void> {
  const out: string[] = [];
  await pipelinePromise(
    (options: { signal: AbortSignal }): Readable => {
      out.push(options.signal.aborted ? "aborted" : "live");
      return Readable.from(["a", "b"]);
    },
    upper,
    sink(out),
  );
  console.log("typed source", out.join(","));

  let typedError: Error | null | undefined;
  let typedValue: unknown;
  const dest = pipeline(
    (): Readable => Readable.from(["p"]),
    (source: Readable) => source,
    (err: Error | null | undefined, value: unknown) => {
      typedError = err;
      typedValue = value;
    },
  ) as PassThrough;
  const chunks: string[] = [];
  for await (const chunk of dest) chunks.push(String(chunk));
  console.log("typed destination", dest.readableObjectMode, chunks.join(","));
  await new Promise<void>((resolve) => setImmediate(resolve));
  console.log("typed destination callback", typedError, typedValue);
}

void main();
