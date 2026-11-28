// pipeline() plain function stages in typed code: a stage's source
// parameter is typed as the stream the pipeline passes it, so the stage
// reads the stream and answers a new async iterable, and the options
// argument takes the signal. A plain destination answers the stream it
// was given, which feeds the PassThrough the callback form returns.
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

const double = (source: Readable): AsyncIterable<string> =>
  (async function* () {
    for await (const chunk of source) yield String(chunk) + String(chunk);
  })();

const upper = (source: Readable, options: { signal: AbortSignal }): AsyncIterable<string> =>
  (async function* () {
    for await (const chunk of source) {
      yield String(chunk).toUpperCase() + (options.signal.aborted ? "!" : "");
    }
  })();

async function main(): Promise<void> {
  const out: string[] = [];
  await pipelinePromise(Readable.from(["a", "b"]), double, sink(out));
  console.log("typed stage", out.join(","));

  const up: string[] = [];
  await pipelinePromise(Readable.from(["x", "y"]), upper, sink(up));
  console.log("typed options stage", up.join(","));

  let typedError: Error | null | undefined;
  let typedValue: unknown;
  const dest = pipeline(
    Readable.from(["p", "q"]),
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
