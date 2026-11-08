// process.stdout and process.stderr handed to code that takes a node:stream
// Writable, in a program with no other stream: each conversion is the same
// stream, and a binding typed Writable is identical to the process stream.
import type { Writable } from "node:stream";

function emit(stream: Writable, text: string): boolean {
  return stream.write(text);
}
class Logger {
  private readonly out: Writable;
  constructor(out: Writable) {
    this.out = out;
  }
  log(text: string): void {
    this.out.write(`${text}\n`);
  }
}
function same(a: Writable, b: Writable): boolean {
  return a === b;
}
const held: Writable = process.stdout;
console.log("returned", emit(process.stdout, "to stdout\n"), emit(process.stderr, "to stderr\n"));
new Logger(process.stdout).log("logged to stdout");
new Logger(process.stderr).log("logged to stderr");
console.log(
  "one stream",
  held === process.stdout,
  same(held, process.stdout),
  same(process.stdout, process.stdout),
  same(process.stdout, process.stderr),
);
