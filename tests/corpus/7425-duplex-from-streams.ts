// Duplex.from over streams in typed code: a Readable that fails destroys
// the Duplex with its error, a slow Writable's callbacks and the end
// callback follow its pace, a pair whose writable member is an async
// generator function's Duplex, compose() with an async function as its
// last stage, and a Duplex over a promise.
import { Duplex, PassThrough, Readable, Writable, compose } from "node:stream";
const log: string[] = [];
async function main(): Promise<void> {
  const failing = new Readable({ read(): void { this.destroy(new Error("source failed")); } });
  const df = Duplex.from(failing);
  df.on("error", (e: Error) => log.push(`df error ${e.message}`));
  df.on("close", () => log.push(`df close ${df.destroyed}`));
  df.resume();
  await new Promise((res) => df.on("close", res));
  const slow = new Writable({
    highWaterMark: 2,
    write(c: Buffer, _e: string, cb: (err?: Error | null) => void): void {
      log.push(`slow write ${c.toString()}`);
      setTimeout(cb, 2);
    },
  });
  const ds = Duplex.from(slow);
  log.push(`write1 ${ds.write("aa", () => log.push("cb aa"))}`);
  log.push(`write2 ${ds.write("bb", () => log.push("cb bb"))}`);
  ds.on("drain", () => log.push("ds drain"));
  ds.end(() => log.push("ds end cb"));
  await new Promise((res) => ds.on("finish", res));
  log.push("ds finished");
  const upper = new PassThrough();
  const dp = Duplex.from({
    readable: Readable.from(["r1", "r2"]),
    writable: async function* (source: AsyncIterable<unknown>): AsyncGenerator<string> {
      for await (const c of source) log.push(`gen got ${String(c)}`);
      yield "unused";
    },
  });
  dp.on("data", (c: unknown) => log.push(`dp data ${String(c)}`));
  dp.write("w1");
  dp.end();
  await new Promise((res) => dp.on("end", res));
  upper.end();
  await more();
  for (const line of log) console.log(line);
}
async function more(): Promise<void> {
  const sink = compose(new PassThrough({ objectMode: true }), async function (source: AsyncIterable<unknown>): Promise<void> {
    for await (const c of source) log.push(`sink ${String(c)}`);
  });
  log.push(`sink r=${sink.readable} w=${sink.writable}`);
  sink.write("p");
  sink.end("q");
  await new Promise((res) => sink.on("finish", res));
  log.push("sink finished");
  const fromReadable: Duplex = Duplex.from(Readable.from([1, 2]));
  const values: unknown[] = [];
  for await (const v of fromReadable) values.push(v);
  log.push(`readable ${JSON.stringify(values)}`);
  const written: string[] = [];
  const target = new Writable({
    write(c: Buffer, _e: string, cb: (err?: Error | null) => void): void {
      written.push(c.toString());
      cb();
    },
  });
  const fromWritable: Duplex = Duplex.from(target);
  fromWritable.end("only");
  await new Promise((res) => fromWritable.on("finish", res));
  log.push(`writable ${written.join(",")}`);
  const value: Duplex = Duplex.from(Promise.resolve("resolved"));
  for await (const v of value) log.push(`promise ${String(v)}`);
}
void main();
