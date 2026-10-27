// Streams that arrive untyped meet NodeJS stream interface slots: an
// untyped JavaScript function's stream returned as NodeJS.ReadableStream,
// a checked cast from 'unknown', pipe() and pipeline() into untyped
// destinations, and 'for await' over a NodeJS.ReadableStream
// parameter fed by a file stream and a child's stdout.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";
import { collector, joined, openUntyped } from "./sources.js";

function open(file: string): NodeJS.ReadableStream {
  return openUntyped(file);
}

function held(file: string): unknown {
  return fs.createReadStream(file);
}

async function collect(label: string, src: NodeJS.ReadableStream): Promise<void> {
  let text = "";
  for await (const chunk of src) text += chunk.toString();
  console.log(label, JSON.stringify(text));
}

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriptc-node-stream-untyped-"));
  const plain = path.join(dir, "plain.txt");
  const packed = path.join(dir, "packed.gz");
  fs.writeFileSync(plain, "plain text\n");
  fs.writeFileSync(packed, zlib.gzipSync(Buffer.from("packed text\n")));

  await collect("returned", open(plain));
  await collect("cast", held(plain) as NodeJS.ReadableStream);
  const child = spawn("sh", ["-c", "printf 'child text\\n'"], { stdio: ["ignore", "pipe", "inherit"] });
  if (child.stdout) await collect("child", child.stdout);

  await new Promise<void>((resolve) => {
    const piped = fs.createReadStream(plain);
    piped.on("end", () => resolve());
    piped.pipe(collector());
  });
  console.log("pipe", JSON.stringify(joined()));

  const sink = collector();
  await pipeline(openUntyped(packed), zlib.createGunzip(), sink);
  console.log("pipeline", JSON.stringify(joined()));
  try {
    await pipeline(openUntyped(path.join(dir, "missing.gz")), zlib.createGunzip(), collector());
  } catch (err) {
    console.log("pipeline error", (err as NodeJS.ErrnoException).code);
  }
  fs.rmSync(dir, { recursive: true });
}

void main();
