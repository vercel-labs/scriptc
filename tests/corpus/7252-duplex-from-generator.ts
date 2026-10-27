// Duplex.from over an async generator function in typed code: the
// generator reads what is written to the Duplex and its values are the
// readable side. Both sides are in object mode with a highWaterMark of
// 1; each write's callback runs once the generator asks for the next
// value, and end() reaches the generator as the end of its source.
import { Duplex } from "node:stream";

const log: string[] = [];

async function* numbered(source: AsyncIterable<unknown>): AsyncGenerator<string> {
  let n = 0;
  for await (const chunk of source) {
    n++;
    log.push(`gen got ${String(chunk)}`);
    yield `${n}:${String(chunk)}`;
  }
  log.push("gen done");
  yield `total ${n}`;
}

async function collect(d: Duplex): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of d) out.push(String(chunk));
  return out;
}

async function basic(): Promise<void> {
  const d = Duplex.from(numbered);
  log.push(`sides ${d.readable} ${d.writable}`);
  log.push(`object mode ${d.readableObjectMode} ${d.writableObjectMode}`);
  log.push(`hwm ${d.readableHighWaterMark} ${d.writableHighWaterMark}`);
  d.write("a", () => log.push("write a done"));
  d.write("b", () => log.push("write b done"));
  d.end("c", () => log.push("end done"));
  const out = await collect(d);
  log.push(`read ${out.join(",")}`);
  log.push(`after ${d.readableEnded} ${d.writableFinished} ${d.destroyed}`);
}

async function values(): Promise<void> {
  // object-mode writes keep their values
  const d = Duplex.from(async function* (source: AsyncIterable<unknown>): AsyncGenerator<string> {
    for await (const v of source) yield typeof v + " " + JSON.stringify(v);
  });
  d.write({ k: 1 });
  d.write([2, 3]);
  d.write(4);
  d.end();
  log.push(`values ${(await collect(d)).join(" | ")}`);
}

async function earlyDestroy(): Promise<void> {
  const d = Duplex.from(numbered);
  d.on("error", (e: Error) => log.push(`error ${e.message}`));
  d.on("close", () => log.push(`close ${d.destroyed}`));
  d.write("x");
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  d.destroy(new Error("stop"));
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
}

async function main(): Promise<void> {
  await basic();
  await values();
  await earlyDestroy();
  for (const line of log) console.log(line);
}

void main();
