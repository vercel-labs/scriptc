// pipeline()'s stream-list form: a lone array argument is the stage list,
// which Node expands into the stages (pipelineImpl). The callback form's
// list, a const list, the promise form, the options after the list, an
// error through the list, and pipelineImpl's fewer-than-two-stages ladder
// in both forms.
import { PassThrough, Readable, Transform, Writable, pipeline } from "node:stream";
import { pipeline as pipelinePromise } from "node:stream/promises";

const out = (line: string): void => console.log(line);

function sink(chunks: string[]): Writable {
  return new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void): void {
      chunks.push(chunk.toString());
      cb();
    },
  });
}

async function main(): Promise<void> {
  const seen: string[] = [];
  const dst = sink(seen);
  let returned: Writable | null = null;
  await new Promise<void>((resolve) => {
    returned = pipeline([Readable.from(["a", "b"]), new PassThrough(), dst], (err?: Error | null): void => {
      out(`array cb ${err === undefined || err === null ? "clean" : err.message} chunks ${seen.join(",")}`);
      resolve();
    });
  });
  out(`array returns destination ${String(returned === dst)}`);

  const declared: string[] = [];
  // The elements name the streams the array holds: the pipeline pipes the
  // stored stages, so an initializer that creates a stream has no lowering.
  const readStage = Readable.from(["c", "d"]);
  const writeStage = sink(declared);
  const stages = [readStage, writeStage];
  await new Promise<void>((resolve) => {
    pipeline(stages, (err?: Error | null): void => {
      out(`const list ${err === undefined || err === null ? "clean" : err.message} chunks ${declared.join(",")}`);
      resolve();
    });
  });

  const promised: string[] = [];
  await pipelinePromise([Readable.from(["e"]), sink(promised)]);
  out(`promise array chunks ${promised.join(",")}`);

  const opened: string[] = [];
  const openDst = sink(opened);
  await pipelinePromise([Readable.from(["f"]), openDst], { end: false });
  out(`options end ${String(openDst.writableEnded)} chunks ${opened.join(",")}`);
  openDst.end();
  await new Promise<void>((resolve) => openDst.on("close", () => resolve()));

  const failing = new Readable({
    read(): void {
      this.push("x");
    },
  });
  const boom = new Transform({
    transform(_chunk: Buffer, _enc: string, cb: (error?: Error | null) => void): void {
      cb(new Error("boom"));
    },
  });
  const torn = sink([]);
  const tornError = await new Promise<string>((resolve) => {
    pipeline([failing, boom, torn], (err?: Error | null) => {
      resolve(err === undefined || err === null ? "clean" : `${err.name} ${err.message}`);
    });
  });
  out(`error through the list ${tornError}`);

  const throwsMissing = (fn: () => unknown): void => {
    try {
      fn();
      out("no throw");
    } catch (e) {
      const err = e as Error & { code?: string };
      out(`${err.name} ${String(err.code)} ${err.message}`);
    }
  };
  throwsMissing(() => pipeline([], (_err?: Error | null): void => {}));
  throwsMissing(() => pipeline([sink([])], (_err?: Error | null): void => {}));
  throwsMissing(() => pipeline(Readable.from(["g"]), (_err?: Error | null): void => {}));

  const rejects = async (promise: Promise<void>): Promise<void> => {
    try {
      await promise;
      out("resolved");
    } catch (e) {
      const err = e as Error & { code?: string };
      out(`${err.name} ${String(err.code)} ${err.message}`);
    }
  };
  await rejects(pipelinePromise([]));
  await rejects(pipelinePromise([sink([])]));
}

void main();
