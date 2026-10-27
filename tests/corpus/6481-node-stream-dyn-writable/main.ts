// NodeJS.WritableStream slots hold a native Writable, a plain JavaScript
// sink and process.stdout: TypeScript writes and ends them, and a copy
// helper typed over both interfaces pipes native and JavaScript sources
// into native and JavaScript destinations.
import { Readable, Writable } from "node:stream";
import { plainSink, plainSource } from "./sources.js";

function emit(label: string, out: NodeJS.WritableStream): void {
  const ok = out.write(`${label} one\n`);
  out.write(`${label} two\n`);
  console.log(label, "write answered", typeof ok);
}

function finish(out: NodeJS.WritableStream): void {
  out.end();
}

function copy(src: NodeJS.ReadableStream, dst: NodeJS.WritableStream): NodeJS.WritableStream {
  return src.pipe(dst);
}

function collector(parts: string[]): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, done) {
      parts.push(chunk.toString());
      done();
    },
  });
}

async function main(): Promise<void> {
  const parts: string[] = [];
  const native = collector(parts);
  const finished = new Promise<void>((resolve) => native.on("finish", () => resolve()));
  emit("native", native);
  finish(native);
  await finished;
  console.log("native got", JSON.stringify(parts.join("")));

  const sink = plainSink("plain");
  emit("plain", sink);
  finish(sink);

  emit("stdout", process.stdout);

  const target = plainSink("copy native into plain");
  console.log("copy returns target", copy(Readable.from(["c1", "c2"]), target) === target);
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  copy(plainSource(["c3", "c4"]), plainSink("copy plain into plain"));
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  const copied: string[] = [];
  const native2 = collector(copied);
  await new Promise<void>((resolve) => {
    native2.on("finish", () => resolve());
    copy(plainSource(["c5", "c6"]), native2);
  });
  console.log("copy plain into native", copied.join(""));
  const copiedNative: string[] = [];
  const native3 = collector(copiedNative);
  await new Promise<void>((resolve) => {
    native3.on("finish", () => resolve());
    copy(Readable.from(["c7", "c8"]), native3);
  });
  console.log("copy native into native", copiedNative.join(""));
}

void main();
