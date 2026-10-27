// process.stdout and process.stderr reach an untyped JavaScript helper
// through NodeJS.WritableStream slots, and the helper pipes into them. As
// in Node, the pipe leaves the process stream open, so later writes
// through the same slots still work.
import { Readable, Writable } from "node:stream";
import { pipeAll } from "./pipe.js";

class Sink extends Writable {
  readonly parts: string[] = [];
  _write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
    this.parts.push(chunk.toString("utf8"));
    callback();
  }
}

function into(destination: NodeJS.WritableStream, parts: string[]): Promise<void> {
  return new Promise((resolve) => {
    pipeAll(Readable.from(parts), destination, () => resolve());
  });
}

function write(destination: NodeJS.WritableStream, text: string): boolean {
  return destination.write(text);
}

async function main(): Promise<void> {
  const sink = new Sink();
  await into(sink, ["to ", "a sink"]);
  console.log("sink", JSON.stringify(sink.parts), sink.writableEnded);
  await into(process.stdout, ["piped ", "by javascript\n"]);
  console.log("write after pipe", write(process.stdout, "still open\n"));
  await into(process.stderr, ["piped to stderr\n"]);
  write(process.stderr, "stderr still open\n");
}

void main();
