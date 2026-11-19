// readable.wrap: the old-style source's chunks are pushed into the wrapper
// (pausing the source while the wrapper is full), its 'end' ends the wrapper,
// its 'error' destroys the wrapper with the same error, and its 'close'
// destroys the wrapper. wrap returns the readable it was called on.
import { PassThrough, Readable } from "node:stream";

const log: string[] = [];

async function ticks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise<void>((resolve) => setTimeout(resolve, 1));
}

async function main(): Promise<void> {
  {
    const source = new PassThrough();
    const wrapped = new Readable({ read() {} });
    const returned = wrapped.wrap(source);
    log.push(`returns receiver ${returned === wrapped}`);
    const chunks: string[] = [];
    wrapped.on("data", (data: Buffer) => chunks.push(String(data)));
    const ended = new Promise<void>((resolve) => wrapped.once("end", resolve));
    source.write("alpha");
    source.write("beta");
    source.end("gamma");
    await ended;
    log.push(`chunks ${chunks.join("|")}`);
    log.push(`ended ${wrapped.readableEnded} source ended ${source.readableEnded}`);
    log.push(`destroyed ${wrapped.destroyed} source destroyed ${source.destroyed}`);
  }

  {
    // A full wrapper pauses the source; reading resumes it.
    const source = new PassThrough();
    const wrapped = new Readable({ highWaterMark: 2, read() {} }).wrap(source);
    let pauses = 0;
    source.on("pause", () => pauses++);
    source.write("abcde");
    await ticks(1);
    log.push(`paused ${pauses > 0} length ${wrapped.readableLength} flowing ${wrapped.readableFlowing === null}`);
    const first = wrapped.read(2);
    log.push(`first ${String(first)} length ${wrapped.readableLength}`);
    const rest: string[] = [];
    wrapped.on("data", (data: Buffer) => rest.push(String(data)));
    source.end("f");
    await new Promise<void>((resolve) => wrapped.once("end", resolve));
    log.push(`rest ${rest.join("|")}`);
  }

  {
    // The source's error reaches the wrapper, which is destroyed with it.
    const source = new PassThrough();
    const wrapped = new Readable({ read() {} }).wrap(source);
    const errors: string[] = [];
    wrapped.on("error", (error: Error) => errors.push(error.message));
    wrapped.on("close", () => log.push("wrapper closed"));
    source.destroy(new Error("source failed"));
    await ticks(2);
    log.push(`errors ${errors.join("|")} destroyed ${wrapped.destroyed} errored ${wrapped.errored?.message}`);
  }

  {
    // A source the program drops stays alive through the wrapper: the chunks
    // still buffered in the paused source arrive when the wrapper reads.
    function makeWrapper(): Readable {
      const source = new PassThrough();
      const wrapped = new Readable({ highWaterMark: 1, read() {} }).wrap(source);
      source.write("a");
      source.write("b");
      source.write("c");
      source.end("d");
      return wrapped;
    }
    const wrapped = makeWrapper();
    const chunks: string[] = [];
    wrapped.on("data", (data: Buffer) => chunks.push(String(data)));
    await new Promise<void>((resolve) => wrapped.once("end", resolve));
    log.push(`dropped source ${chunks.join("|")}`);
  }

  {
    // A clean source close destroys the wrapper without an error.
    const source = new PassThrough();
    const wrapped = new Readable({ read() {} }).wrap(source);
    const errors: string[] = [];
    wrapped.on("error", (error: Error) => errors.push(error.message));
    let closed = false;
    wrapped.on("close", () => (closed = true));
    source.destroy();
    await ticks(2);
    log.push(`clean close closed ${closed} destroyed ${wrapped.destroyed} errors ${errors.length}`);
  }
}

await main();
console.log(log.join("\n"));
