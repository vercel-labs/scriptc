// A process stream where a record type names some of its members
// (`{ isTTY?: boolean }`, `{ columns?: number }`, `{ fd: number }`): a
// declared function's parameter and a const hold the stream itself, so a
// member answers the stream's value at the time of the read and `===`
// compares the stream. The same function also takes plain records.
import type * as tty from "node:tty";

type TermStream = { isTTY?: boolean };

function describe(stream: TermStream): string {
  const where =
    stream === process.stderr ? "stderr" : stream === process.stdout ? "stdout" : "other";
  return `${where}:${stream.isTTY ? "terminal" : "plain"}`;
}
console.log(describe(process.stdout), describe(process.stderr));
console.log(describe({ isTTY: true }), describe({}));

// A const keeps the stream.
const held: TermStream = process.stderr;
console.log(held === process.stderr, held === process.stdout, describe(held));
console.log(held.isTTY === process.stderr.isTTY);

// Whatever expression answers the stream.
const useError = process.argv.length < 99;
const picked: TermStream = useError ? process.stderr : process.stdout;
console.log(describe(picked), describe(useError ? process.stdout : process.stderr));

// Optional and nullable parameters receive the stream as given.
function maybe(stream?: TermStream): string {
  return stream === undefined ? "none" : describe(stream);
}
function orNull(stream: TermStream | null): string {
  return stream ? describe(stream) : "null";
}
console.log(maybe(), maybe(process.stdout), maybe({ isTTY: true }));
console.log(orNull(null), orNull(process.stderr), orNull({}));

// Other data members of the stream.
function width(stream: { columns?: number }): number {
  return stream.columns ?? 80;
}
function height(stream: { rows?: number }): number {
  return stream.rows ?? 24;
}
function descriptor(stream: { fd: number }): number {
  return stream.fd;
}
console.log(width(process.stdout), width({ columns: 12 }), height(process.stderr));
console.log(descriptor(process.stdout), descriptor(process.stderr), descriptor({ fd: 7 }));

// Data members and a method together.
interface Terminal {
  isTTY?: boolean;
  write(text: string): boolean;
}
function emit(out: Terminal, text: string): void {
  out.write(`${out === process.stdout ? "stdout" : "other"} ${out.isTTY ? "terminal" : "plain"} ${text}\n`);
}
emit(process.stdout, "direct");
emit(
  {
    isTTY: true,
    write: (text) => {
      console.log("record " + text.trim());
      return true;
    },
  },
  "wrapped",
);

// The stream reaches the parameter through a typed class field, another
// declared function, and a closure.
class Output {
  stream: tty.WriteStream;
  constructor(stream: tty.WriteStream) {
    this.stream = stream;
  }
  kind(): string {
    return describe(this.stream);
  }
}
console.log(new Output(process.stderr).kind(), new Output(process.stdout).kind());

function outer(stream: TermStream): string {
  return `[${describe(stream)}]`;
}
function later(stream: TermStream): () => string {
  return () => describe(stream);
}
console.log(outer(process.stderr), outer({ isTTY: true }), later(process.stdout)(), later({})());

// Two streams, two parameters.
function same(a: TermStream, b: TermStream): string {
  return `${a === b}:${a === process.stdout}:${b === process.stderr}`;
}
console.log(same(process.stdout, process.stdout), same(process.stdout, process.stderr));
console.log(same({}, process.stderr));

// A parameter that defaults to a stream: a call that omits the argument
// passes the stream itself.
function theme(stream: TermStream = process.stdout, options: { plain?: boolean } = {}): string {
  const off = (options.plain ?? false) || !stream.isTTY;
  return `${stream === process.stderr ? "stderr" : "stdout"}:${off ? "off" : "on"}`;
}
console.log(theme(), theme(process.stderr), theme(process.stderr, { plain: true }));
console.log(theme({ isTTY: true }), theme({ isTTY: true }, { plain: true }), theme({}));
function columns(stream: { columns?: number } = process.stderr): number {
  return stream.columns ?? 80;
}
console.log(columns(), columns({ columns: 5 }), columns(process.stdout));
