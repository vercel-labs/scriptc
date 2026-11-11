// stream.compose and readable.compose: the composed Duplex's modes and
// return/end behavior, a single Duplex answering itself, the missing
// arguments ladder, a failing stage's error reaching the composed duplex,
// a destroyed stage, and readable.compose(stage, { signal }) aborting the
// composed duplex.
import { Duplex, PassThrough, Readable, Transform, compose } from "node:stream";

const describe = (error: unknown): string =>
  error === null || error === undefined
    ? "none"
    : `${(error as Error).name} ${(error as NodeJS.ErrnoException).code ?? "-"} ${(error as Error).message}`;
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function drain(duplex: Duplex, chunks: string[]): Promise<string[]> {
  const out: string[] = [];
  duplex.on("data", (chunk: unknown) => out.push(String(chunk)));
  const ended = new Promise<void>((resolve) => duplex.on("end", resolve));
  for (const chunk of chunks) duplex.write(chunk);
  duplex.end();
  await ended;
  return out;
}

async function main(): Promise<void> {
  // Two object-mode streams: the composed Duplex follows their modes and
  // round-trips values.
  {
    const composed = compose(
      new PassThrough({ objectMode: true }),
      new PassThrough({ objectMode: true }),
    );
    console.log("modes", composed.readableObjectMode, composed.writableObjectMode);
    console.log("values", (await drain(composed, ["a", "b"])).join(","));
    console.log("state", composed.writableFinished, composed.readableEnded, composed.destroyed);
  }

  // A single Duplex is the composed stream itself.
  {
    const through = new PassThrough();
    console.log("single", compose(through) === through);
    const transform = new Transform({
      transform(chunk: Buffer, _encoding: string, callback: (error?: Error | null, data?: Buffer) => void): void {
        callback(null, chunk);
      },
    });
    console.log("single transform", compose(transform) === transform);
  }

  // The argument and stream-side ladders.
  {
    try {
      compose();
    } catch (error) {
      console.log("missing", describe(error));
    }
  }

  // A failing middle stage: the composed duplex errors and rejects writes
  // buffered behind it.
  {
    const failing = new Transform({
      transform(_chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
        callback(new Error("stage failed"));
      },
    });
    const broken = compose(new PassThrough(), failing);
    broken.on("error", (error: Error) => console.log("broken error", describe(error)));
    broken.on("close", () => console.log("broken close", broken.destroyed));
    broken.write("x", (error?: Error | null) => console.log("broken write callback", describe(error)));
    await turn();
    console.log("broken state", broken.destroyed, describe(broken.errored));
  }

  // A destroyed stage closes the composed duplex.
  {
    const dead = new PassThrough();
    const chain = compose(dead, new PassThrough());
    chain.on("data", () => console.log("chain data"));
    chain.on("error", (error: Error) => console.log("chain error", describe(error)));
    chain.on("close", () => console.log("chain close", chain.destroyed));
    dead.destroy();
    await turn();
    chain.write("y", (error?: Error | null) => console.log("chain write callback", describe(error)));
    await turn();
    console.log("chain state", chain.destroyed, describe(chain.errored));
  }

  // readable.compose(stage): the readable side flows through the stage;
  // the writable side is already ended, so write() reports write-after-end.
  {
    const upper = new Transform({
      transform(chunk: Buffer, _encoding: string, callback: (error?: Error | null, data?: Buffer) => void): void {
        callback(null, Buffer.from(chunk.toString().toUpperCase()));
      },
    });
    const composed = Readable.from(["a", "b"]).compose(upper);
    composed.on("error", (error: Error) => console.log("readable compose error", describe(error)));
    const out: string[] = [];
    composed.on("data", (chunk: Buffer) => out.push(chunk.toString()));
    composed.on("end", () => console.log("readable compose end", composed.readableEnded));
    composed.on("close", () => console.log("readable compose close", composed.destroyed));
    composed.write("x", (error?: Error | null) => console.log("readable compose write callback", describe(error)));
    await turn();
    console.log("readable compose out", out.join(","));
    console.log("readable compose state", composed.readableEnded, composed.destroyed);
  }

  // readable.compose(stage, { signal }): the abort destroys the composed
  // duplex with an AbortError.
  {
    const controller = new AbortController();
    const composed = new PassThrough().compose(new PassThrough(), {
      signal: controller.signal,
    });
    composed.on("error", (error: Error) => console.log("signal error", describe(error)));
    composed.on("close", () => console.log("signal close", composed.destroyed));
    controller.abort();
    await turn();
    console.log("signal state", composed.destroyed, describe(composed.errored));
  }

  // readable.compose keeps object mode from the stage.
  {
    const composed = new PassThrough().compose(new PassThrough({ objectMode: true }));
    console.log("object stage", composed.readableObjectMode, composed.writableObjectMode);
    const values = await drain(composed, ["a", "b"]);
    console.log("object stage values", values.join(","));
  }
}

void main();
