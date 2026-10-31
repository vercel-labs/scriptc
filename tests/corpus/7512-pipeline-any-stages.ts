// pipeline() in TypeScript with stages after the first typed any or
// unknown: functions run as function stages, streams are piped, and an
// iterable is taken as Duplex.from of it.
import { pipeline, Readable, Writable, PassThrough } from "node:stream";
import { pipeline as pipelineP } from "node:stream/promises";

function sink(label: string): Writable {
  return new Writable({
    objectMode: true,
    write(chunk: unknown, _enc, cb) {
      console.log(label, JSON.stringify(chunk));
      cb();
    },
  });
}

async function main(): Promise<void> {
  const shout: any = async function* (source: any) {
    for await (const chunk of source) yield String(chunk).toUpperCase();
  };
  await pipelineP(Readable.from(["a", "b"]), shout, sink("function"));

  const total: unknown = async (source: any) => {
    let sum = 0;
    for await (const chunk of source) sum += Number(chunk);
    return sum;
  };
  const sum = await pipelineP(Readable.from(["1", "2", "3"]), total as any);
  console.log("sum", sum);

  const relay: any = new PassThrough({ objectMode: true });
  await pipelineP(Readable.from([{ k: 1 }]), relay, sink("stream"));

  const values: any = ["v1", "v2"];
  await pipelineP(Readable.from(["unread"]), values, sink("iterable"));

  await new Promise<void>((resolve) => {
    pipeline(Readable.from(["x"]), shout, sink("callback"), (err: NodeJS.ErrnoException | null) => {
      console.log("callback done", err == null);
      resolve();
    });
  });
}

main().then(() => console.log("done"));
