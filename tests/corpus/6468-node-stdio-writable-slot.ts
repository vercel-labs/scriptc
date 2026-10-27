// process.stdout and process.stderr in NodeJS.WritableStream slots of a
// program that also passes other streams there: every slot holds the same
// stream object, a pipe through such a slot leaves the process stream
// open, and Writable's listener methods return the stream for chaining.
import { Readable, Writable } from "node:stream";

class Sink extends Writable {
  _write(_chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
    callback();
  }
}

function same(a: NodeJS.WritableStream, b: NodeJS.WritableStream): boolean {
  return a === b;
}

function pipeInto(dst: NodeJS.WritableStream, parts: string[]): Promise<void> {
  return new Promise((resolve) => {
    const src = Readable.from(parts);
    src.on("end", () => resolve());
    src.pipe(dst);
  });
}

function write(dst: NodeJS.WritableStream, text: string): boolean {
  return dst.write(text);
}

async function main(): Promise<void> {
  console.log("stdout same", same(process.stdout, process.stdout));
  console.log("stderr same", same(process.stderr, process.stderr));
  console.log("stdout and stderr", same(process.stdout, process.stderr));
  console.log("sink and stdout", same(new Sink(), process.stdout));

  await pipeInto(process.stdout, ["piped ", "through ", "a slot\n"]);
  // The pipe did not end process.stdout: writes through a slot still work.
  console.log("write after pipe", write(process.stdout, "still open\n"));
  await pipeInto(process.stderr, ["piped to stderr\n"]);
  write(process.stderr, "stderr still open\n");

  // Writable's listener methods return the stream.
  const sink = new Sink();
  await new Promise<void>((resolve) => {
    sink.on("finish", () => resolve()).end("done");
  });
  console.log("sink finished", sink.writableFinished);
}

void main();
