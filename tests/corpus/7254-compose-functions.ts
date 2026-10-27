// stream.compose with async generator function stages in typed code: a
// function at either end becomes Duplex.from of it, functions between
// streams run as pipeline stages, and one stage is Duplex.from of it.
// The composed Duplex writes to the first stage and reads from the last;
// its object modes follow the first stage's writable side and the last
// stage's readable side.
import { Duplex, PassThrough, Transform, compose } from "node:stream";

const log: string[] = [];

async function* upper(source: AsyncIterable<unknown>): AsyncGenerator<string> {
  for await (const chunk of source) yield String(chunk).toUpperCase();
}

async function* numbered(source: AsyncIterable<unknown>): AsyncGenerator<string> {
  let n = 0;
  for await (const chunk of source) yield `${++n}.${String(chunk)}`;
}

async function drain(name: string, d: Duplex, chunks: string[]): Promise<void> {
  log.push(`${name} r=${d.readable} w=${d.writable} ro=${d.readableObjectMode} wo=${d.writableObjectMode}`);
  const out: string[] = [];
  d.on("data", (c: unknown) => out.push(String(c)));
  const ended = new Promise<void>((resolve) => d.on("end", () => resolve()));
  for (const c of chunks) d.write(c);
  d.end();
  await ended;
  log.push(`${name} ${out.join(" ")}`);
}

async function main(): Promise<void> {
  // functions only: Duplex.from at both ends
  await drain("fns", compose(upper, numbered), ["a", "b"]);
  // a function between two object-mode streams
  await drain(
    "middle",
    compose(new PassThrough({ objectMode: true }), upper, new PassThrough({ objectMode: true })),
    ["c", "d"],
  );
  // a byte stream before a function: the Duplex writes bytes
  const bytes = compose(new PassThrough(), numbered);
  await drain("bytes", bytes, ["e"]);
  // a function before a Transform
  const tail = new Transform({
    objectMode: true,
    transform(chunk: unknown, _enc: string, cb: (err?: Error | null, data?: unknown) => void): void {
      cb(null, `<${String(chunk)}>`);
    },
  });
  await drain("transform", compose(upper, tail), ["f", "g"]);
  // one stage
  await drain("single", compose(numbered), ["h", "i", "j"]);
  for (const line of log) console.log(line);
}

void main();
