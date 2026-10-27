// NodeJS.ReadableStream is the interface every Node readable implements.
// One helper typed with it consumes a file stream, a Readable subclass,
// Readable.from, a gunzip Transform fed through pipe(), and a child's
// stdout. A program that mixes those producers compiles the interface as
// the node:stream Readable, with the child's pipe bridged into one.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import * as zlib from "node:zlib";

function drain(label: string, src: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    let chunks = 0;
    src.on("data", (chunk: Buffer | string) => {
      chunks++;
      text += typeof chunk === "string" ? `[s]${chunk}` : chunk.toString("utf8");
    });
    src.on("error", (err) => reject(err));
    src.on("end", () => {
      console.log(label, "end", chunks > 0, src.readable);
      resolve(text);
    });
  });
}

class Countdown extends Readable {
  private left = 3;
  _read(): void {
    this.push(this.left > 0 ? `t-${this.left--};` : null);
  }
}

function openText(file: string): NodeJS.ReadableStream {
  return fs.createReadStream(file);
}

function openDecoded(file: string): NodeJS.ReadableStream {
  const stream = fs.createReadStream(file);
  stream.setEncoding("utf8");
  return stream;
}

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriptc-node-readable-"));
  const plain = path.join(dir, "plain.txt");
  const packed = path.join(dir, "packed.gz");
  fs.writeFileSync(plain, "hello from a file\n");
  fs.writeFileSync(packed, zlib.gzipSync(Buffer.from("inflated text\n")));

  console.log(JSON.stringify(await drain("file", openText(plain))));
  console.log(JSON.stringify(await drain("decoded", openDecoded(plain))));
  console.log(JSON.stringify(await drain("subclass", new Countdown())));
  console.log(JSON.stringify(await drain("from", Readable.from(["a", "b", "c"]))));
  const gunzip = fs.createReadStream(packed).pipe(zlib.createGunzip());
  console.log(JSON.stringify(await drain("gunzip", gunzip)));

  const child = spawn("sh", ["-c", "printf 'child line\\n'"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const out = child.stdout;
  if (out !== null) console.log(JSON.stringify(await drain("child", out)));
  console.log("same stdout", child.stdout === out);

  try {
    await drain("missing", openText(path.join(dir, "missing.txt")));
  } catch (err) {
    console.log("missing", (err as NodeJS.ErrnoException).code);
  }
  fs.rmSync(dir, { recursive: true });
}

void main();
