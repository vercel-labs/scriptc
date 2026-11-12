// Readable.from's `encoding` option: the empty string is falsy, so
// from.js's `if (options.encoding)` passes it by and the stream keeps its
// own default. A string source in byte mode decodes as utf8; a Buffer
// source stays a Buffer.
import { Readable } from "node:stream";

const out = (line: string): void => console.log(line);

async function collect(label: string, stream: Readable): Promise<void> {
  const seen: string[] = [];
  for await (const chunk of stream) {
    seen.push(typeof chunk === "string" ? `string ${String(chunk)}` : `bytes ${(chunk as Buffer).length}`);
  }
  out(`${label} ${seen.join(",")} encoding ${String(stream.readableEncoding)}`);
}

async function main(): Promise<void> {
  await collect("strings", Readable.from(["a", "bc"], { encoding: "" as BufferEncoding }));
  await collect("buffers", Readable.from([Buffer.from([0xe9])], { encoding: "" as BufferEncoding }));
}

void main();
