// @types/node's stream interfaces fed by every producer: NodeJS.ReadableStream
// and stream.Readable slots take file streams, a gunzip Transform and a
// child's stdout; NodeJS.WritableStream and stream.Writable slots take file
// streams and process.stdout.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import * as zlib from "node:zlib";

function drain(label: string, src: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    src.on("data", (chunk: Buffer | string) => {
      text += chunk.toString();
    });
    src.on("error", reject);
    src.on("end", () => {
      console.log(label, "end");
      resolve(text);
    });
  });
}

function emit(dst: NodeJS.WritableStream, line: string): void {
  dst.write(`${line}\n`);
}

function finish(dst: Writable): Promise<void> {
  return new Promise((resolve) => dst.end(() => resolve()));
}

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriptc-node-types-streams-"));
  const plain = path.join(dir, "plain.txt");
  const packed = path.join(dir, "packed.gz");
  fs.writeFileSync(plain, "from a file\n");
  fs.writeFileSync(packed, zlib.gzipSync(Buffer.from("from gunzip\n")));
  const file: Readable = fs.createReadStream(plain);
  console.log(JSON.stringify(await drain("file", file)));
  console.log(JSON.stringify(await drain("gunzip", fs.createReadStream(packed).pipe(zlib.createGunzip()))));
  const child = spawn("sh", ["-c", "printf 'from a child\\n'"], { stdio: ["ignore", "pipe", "inherit"] });
  if (child.stdout) console.log(JSON.stringify(await drain("child", child.stdout)));

  const target = path.join(dir, "out.txt");
  const out: Writable = fs.createWriteStream(target);
  emit(out, "to a file");
  emit(process.stdout, "to stdout");
  await finish(out);
  console.log(JSON.stringify(fs.readFileSync(target, "utf8")));
  await new Promise<void>((resolve) => {
    const piped = fs.createReadStream(plain);
    piped.on("end", () => resolve());
    piped.pipe(process.stdout);
  });
  emit(process.stdout, "stdout still open");
  fs.rmSync(dir, { recursive: true });
}

void main();
