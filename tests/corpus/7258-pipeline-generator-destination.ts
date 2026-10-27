// pipeline() with a function destination in typed code. @types/node and
// the fallback declarations type the result as the destination stream;
// for a function destination it is the object-mode PassThrough that
// pipeline() returns, read here as a PassThrough.
import { PassThrough, Readable, pipeline } from "node:stream";

const log: string[] = [];

async function* tokens(source: AsyncIterable<unknown>): AsyncGenerator<string> {
  for await (const line of source) {
    for (const word of String(line).split(" ")) yield word;
  }
}

async function* tagged(source: AsyncIterable<string>): AsyncGenerator<{ word: string; n: number }> {
  let n = 0;
  for await (const word of source) yield { word, n: ++n };
}

async function main(): Promise<void> {
  const out = pipeline(Readable.from(["to be", "or not"]), tokens, tagged, (err: Error | null) => {
    log.push(`callback ${err === null || err === undefined ? "ok" : err.message}`);
  }) as PassThrough;
  log.push(`object mode ${out.readableObjectMode} ${out.writableObjectMode}`);
  for await (const item of out) {
    const entry = item as { word: string; n: number };
    log.push(`${entry.n} ${entry.word}`);
  }
  log.push(`ended ${out.readableEnded}`);

  const counted = pipeline(
    Readable.from(["x", "y", "z"]),
    async function (source: AsyncIterable<unknown>): Promise<number> {
      let n = 0;
      for await (const _ of source) n++;
      return n;
    },
    (err: Error | null) => log.push(`count callback ${err === null || err === undefined}`),
  ) as PassThrough;
  const values: unknown[] = [];
  counted.on("data", (v: unknown) => values.push(v));
  await new Promise<void>((resolve) => counted.on("end", () => resolve()));
  log.push(`count values ${JSON.stringify(values)}`);
  for (const line of log) console.log(line);
}

void main();
