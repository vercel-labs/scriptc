// process.stdout and process.stderr flow into narrow writer types: an
// interface variable, a type-alias parameter whose write answers a
// boolean, and an object literal that wraps the stream. Calls through the
// narrow type reach the stream's current write method, so a program that
// replaces process.stdout.write sees its replacement run.
interface Sink {
  write(text: string): void;
}

type Writer = { write(chunk: string): boolean };

function emit(out: Writer, text: string): boolean {
  return out.write(text);
}

const sink: Sink = process.stdout;
sink.write("sink to stdout\n");

console.log(`emit answered ${String(emit(process.stdout, "emit to stdout\n"))}`);
emit(process.stderr, "emit to stderr\n");

const wrapped: Sink = {
  write: (text: string) => {
    process.stdout.write(text);
  },
};
wrapped.write("wrapped to stdout\n");

const original = process.stdout.write;
const seen: string[] = [];
process.stdout.write = ((chunk: string): boolean => {
  seen.push(chunk.trim());
  return true;
}) as typeof process.stdout.write;
sink.write("through the replacement\n");
emit(process.stdout, "emit through the replacement\n");
process.stdout.write = original;
console.log(`replacement saw: ${seen.join(" | ")}`);
