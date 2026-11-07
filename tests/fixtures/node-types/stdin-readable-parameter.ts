// process.stdin handed to code that takes a node:stream Readable: a line
// reader that attaches and detaches its own listeners, a class that keeps
// the stream in a field, and an options record with a Readable member. In
// Node process.stdin is a Readable, so each of them reads the process's
// input; every conversion is the same stream.
import type { Readable } from "node:stream";

function attachLineReader(stream: Readable, onLine: (line: string) => void): () => void {
  let buffer = "";
  const onData = (chunk: string | Buffer) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    while (true) {
      const index = buffer.indexOf("\n");
      if (index === -1) return;
      onLine(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
    }
  };
  const onEnd = () => {
    if (buffer.length > 0) onLine(buffer);
    buffer = "";
  };
  stream.on("data", onData);
  stream.on("end", onEnd);
  return () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
  };
}

class Counter {
  private bytes = 0;
  private readonly input: Readable;
  constructor(input: Readable) {
    this.input = input;
  }
  start(done: (bytes: number) => void): void {
    this.input.on("data", (chunk: Buffer) => {
      this.bytes += chunk.length;
    });
    this.input.on("end", () => done(this.bytes));
  }
}

interface Options {
  input: Readable;
  label: string;
}
function watch(options: Options): void {
  options.input.once("data", (chunk: Buffer) => {
    console.log(options.label, "first chunk", chunk.length > 0, options.input.listenerCount("data"));
  });
}

function same(a: Readable, b: Readable): boolean {
  return a === b;
}
const held: Readable = process.stdin;
console.log("one stream", held === process.stdin, same(held, process.stdin), same(process.stdin, process.stdin));

const detach = attachLineReader(process.stdin, (line) => {
  console.log("line:", line);
});
new Counter(process.stdin).start((bytes) => {
  console.log("bytes:", bytes);
  detach();
  console.log("data listeners left:", held.listenerCount("data"));
});
watch({ input: process.stdin, label: "options" });
