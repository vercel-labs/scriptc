// process.stdin handed to code that takes a node:stream Readable: a function
// that registers a listener of its own and later removes it, a class that
// keeps the stream in a field, and an options record with a Readable member.
// In Node process.stdin is a Readable, so each of them reads the process's
// input; every conversion is the same stream.
import type { Readable } from "node:stream";

// A parameter: keep what arrives until the caller takes it.
function gather(source: Readable): { take(): string } {
  const pieces: string[] = [];
  const keep = (chunk: Buffer): void => {
    pieces.push(chunk.toString("utf8"));
  };
  source.on("data", keep);
  return {
    take(): string {
      source.off("data", keep);
      return pieces.join("");
    },
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

const gathered = gather(process.stdin);
new Counter(process.stdin).start((bytes) => {
  console.log("bytes:", bytes);
  console.log("text:", gathered.take().split("\n").join(" | "));
  console.log("data listeners left:", held.listenerCount("data"));
});
watch({ input: process.stdin, label: "options" });
