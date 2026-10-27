// The helper shapes real code writes around NodeJS.ReadableStream, fed by
// native and JavaScript streams: an async function returning one of
// several producers, a JavaScript consumer of its result, a part piped
// into a PassThrough with { end: false } and unpiped, pause/resume/
// setEncoding/readable, an optional destroy through an intersection type,
// for await and pipeline over native values in the slot.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";
import { openPart, part, streamToText } from "./sources.js";

async function open(kind: string, file: string): Promise<NodeJS.ReadableStream> {
  if (kind === "file") return fs.createReadStream(file);
  return openPart(["x", "y"]);
}

async function pipePart(item: NodeJS.ReadableStream, out: PassThrough): Promise<void> {
  item.pipe(out, { end: false });
  await new Promise<void>((resolve) => item.on("end", () => resolve()));
  item.unpipe(out);
}

function pass(stream: NodeJS.ReadableStream): NodeJS.ReadableStream {
  return stream;
}

function stop(stream: NodeJS.ReadableStream): void {
  (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
}

async function iterate(label: string, stream: NodeJS.ReadableStream): Promise<void> {
  let text = "";
  for await (const chunk of stream) text += chunk.toString();
  console.log(label, "iterated", text);
}

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriptc-stream-dyn-"));
  const file = path.join(dir, "a.txt");
  fs.writeFileSync(file, "file text");
  console.log("file", await streamToText(await open("file", file)));
  console.log("part", await streamToText(await open("part", file)));

  const out = new PassThrough();
  const parts: string[] = [];
  out.on("data", (chunk: Buffer) => parts.push(chunk.toString()));
  await pipePart(await open("part", file), out);
  await pipePart(await open("file", file), out);
  const ended = new Promise<void>((resolve) => out.on("end", () => resolve()));
  out.end();
  await ended;
  console.log("out", parts.join("|"));

  const js = pass(part(["j1"]));
  js.pause();
  js.resume();
  js.setEncoding("utf8");
  console.log("js readable", js.readable);
  await new Promise<void>((resolve) => js.on("end", () => resolve()));
  const native = pass(Readable.from(["n1"]));
  native.setEncoding("utf8");
  console.log("native readable", native.readable);
  const chunks: string[] = [];
  await new Promise<void>((resolve) => {
    native.on("data", (chunk: Buffer | string) => chunks.push(chunk.toString()));
    native.on("end", () => resolve());
  });
  console.log("native chunks", chunks.join(""));

  const closing = pass(Readable.from(["c1"]));
  closing.on("close", () => console.log("native closed"));
  stop(pass(part(["d1"])));
  stop(closing);

  await iterate("native", pass(Readable.from(["i1", "i2"])));
  await iterate("file", pass(fs.createReadStream(file)));

  const packed = path.join(dir, "a.gz");
  fs.writeFileSync(packed, zlib.gzipSync(Buffer.from("packed text")));
  const unpacked: string[] = [];
  await pipeline(
    pass(fs.createReadStream(packed)),
    zlib.createGunzip(),
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        unpacked.push(chunk.toString());
        done();
      },
    }),
  );
  console.log("pipeline", unpacked.join(""));
  fs.rmSync(dir, { recursive: true });
}

void main();
