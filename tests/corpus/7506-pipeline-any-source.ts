// pipeline() in TypeScript over sources typed any or unknown, and over a
// Set, a Map and an async generator object, which are pumped as iterables.
import { pipeline, Writable } from "node:stream";
import { pipeline as pipelineP } from "node:stream/promises";

function sink(label: string): Writable {
  const parts: string[] = [];
  return new Writable({
    objectMode: true,
    write(chunk: unknown, _enc, cb) {
      parts.push(JSON.stringify(chunk));
      cb();
    },
    final(cb) {
      console.log(label, parts.join(" "));
      cb();
    },
  });
}

async function* ticks(): AsyncGenerator<string> {
  yield "t1";
  await new Promise((r) => setTimeout(r, 1));
  yield "t2";
}

async function main(): Promise<void> {
  const anySource: any = ["any1", "any2"];
  await pipelineP(anySource, sink("any"));
  const unknownSource: unknown = new Set([1, 2, 3]);
  await pipelineP(unknownSource as any, sink("unknown"));
  await pipelineP(new Set(["s"]), sink("set"));
  await pipelineP(
    new Map([
      ["a", 1],
      ["b", 2],
    ]),
    sink("map"),
  );
  await pipelineP(ticks(), sink("async generator"));
  await new Promise<void>((resolve) => {
    pipeline(anySource, sink("callback"), (err?: Error | null) => {
      console.log("callback done", err);
      resolve();
    });
  });
}
void main();
