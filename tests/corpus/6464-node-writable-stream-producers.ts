// NodeJS.WritableStream is the interface every Node writable implements:
// process.stdout/stderr, fs.WriteStream and the node:stream Writable
// family. Helpers typed with it accept all of them, a copy helper pipes a
// file stream into one, and readable.pipe(process.stdout) leaves the
// process stream open afterwards, as in Node.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";

function emit(dst: NodeJS.WritableStream, line: string): boolean {
  return dst.write(`${line}\n`);
}

function copy(src: NodeJS.ReadableStream, dst: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    src.on("error", reject);
    dst.on("error", reject);
    dst.on("finish", () => resolve());
    src.pipe(dst);
  });
}

class Collector extends Writable {
  readonly parts: string[] = [];
  _write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
    this.parts.push(chunk.toString("utf8"));
    callback();
  }
}

function finished(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve) => {
    stream.end(() => resolve());
  });
}

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriptc-node-writable-"));
  const target = path.join(dir, "out.txt");
  const file = fs.createWriteStream(target);
  console.log("file write", emit(file, "to a file"));
  console.log("stdout write", emit(process.stdout, "to stdout"));
  emit(process.stderr, "to stderr");
  const collector = new Collector();
  emit(collector, "to a collector");
  await finished(file);
  await finished(collector);
  console.log(JSON.stringify(fs.readFileSync(target, "utf8")));
  console.log(JSON.stringify(collector.parts));

  const source = path.join(dir, "source.txt");
  const copied = path.join(dir, "copied.txt");
  fs.writeFileSync(source, "copied through pipe\n");
  await copy(fs.createReadStream(source), fs.createWriteStream(copied));
  console.log(JSON.stringify(fs.readFileSync(copied, "utf8")));

  await new Promise<void>((resolve) => {
    const piped = Readable.from(["piped ", "to ", "stdout\n"]);
    piped.on("end", () => resolve());
    console.log("pipe answers stdout", piped.pipe(process.stdout) === process.stdout);
  });
  // The pipe did not end process.stdout.
  emit(process.stdout, "still writable");
  fs.rmSync(dir, { recursive: true });
}

void main();
