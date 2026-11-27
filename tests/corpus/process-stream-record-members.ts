// A process stream flows into a record type that declares the stream's data
// members beside its methods: each data member is read off the stream when
// the record is built, and a call through the record runs the stream's
// current method.
interface Sink {
  write(text: string): void;
  isTTY: boolean | undefined;
}

interface Terminal {
  isTTY?: boolean;
}

interface Options {
  stream?: { isTTY?: boolean };
}

function describe(options: Options): string {
  return options.stream?.isTTY === true ? "color" : "plain";
}

function report(sink: Sink, text: string): void {
  sink.write(text);
}

function theme(stream: Terminal): string {
  return stream.isTTY === true ? "color" : "plain";
}

function acceptsWriter(stream: { write: unknown }): string {
  return typeof stream.write;
}

const sink: Sink = process.stdout;
report(sink, `sink isTTY ${String(sink.isTTY)}\n`);
report(process.stderr, "stderr through its record\n");
const terminal: Terminal = process.stderr;
console.log("stderr theme", theme(terminal));
console.log("stdout theme", theme(process.stdout));
console.log("writer kind", acceptsWriter(process.stdout));
console.log("option theme", describe({ stream: process.stderr }));

const original = process.stdout.write;
let seen = "";
process.stdout.write = ((text: string): boolean => {
  seen += text;
  return true;
}) as typeof process.stdout.write;
const live: Sink = process.stdout;
live.write("through the replacement\n");
process.stdout.write = original;
console.log("replacement saw", JSON.stringify(seen));

interface OptionalSink {
  write?: (text: string) => boolean;
}

const optional: OptionalSink = process.stdout;
console.log("optional write", optional.write?.("optional through the record\n"));
