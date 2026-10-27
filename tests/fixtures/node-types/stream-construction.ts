// Streams constructed under @types/node: option-bag Transform and
// PassThrough streams with @types/node's TransformCallback, a gunzip stage,
// fs.ReadStream listeners, and child-process listeners declared with
// unknown chunks and non-null exit types.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, Transform } from "node:stream";
import { createGunzip, gzipSync } from "node:zlib";

interface Progress {
  bytes: number;
  chunks: number;
}

function createCounter(progress: Progress) {
  return new Transform({
    transform(chunk, _encoding, callback) {
      const length = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      progress.bytes += length;
      progress.chunks++;
      callback(null, chunk);
    },
    flush(callback) {
      callback();
    },
  });
}

function gunzipThrough(payload: Buffer): Promise<string> {
  return new Promise((resolve) => {
    const progress: Progress = { bytes: 0, chunks: 0 };
    const counter = createCounter(progress);
    const gunzip = createGunzip();
    const out = new PassThrough();
    const parts: string[] = [];
    counter.pipe(gunzip).pipe(out);
    out.on("data", (d: Buffer) => parts.push(d.toString()));
    out.on("end", () => resolve(`${parts.join("")} ${progress.bytes > 0} ${progress.chunks}`));
    counter.end(payload);
  });
}

// Resolves after 'close', which follows 'end' once the descriptor is
// closed: the result never races the child processes started next.
function readFileStream(file: string): Promise<string> {
  return new Promise((resolve) => {
    const stream = fs.createReadStream(file);
    let text = "";
    const release = () => {
      console.log("released");
      resolve(text);
    };
    stream.on("close", release);
    stream.on("error", release);
    stream.on("data", (chunk) => {
      text += chunk.toString();
    });
  });
}

function run(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", script], { stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (c) => {
        stdout += c;
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (c) => {
        const chunk = String(c);
        stderr += chunk;
      });
    }
    child.on("error", reject);
    child.on("close", (code: number, signal: string) => {
      if (code === 0) return resolve(stdout);
      reject(new Error(`Exited with ${code || signal}: ${stderr.trim()}`));
    });
  });
}

// setEncoding returns its stream: a listener on the returned value, or on
// the stream after `const out = stream.setEncoding(...)`, receives strings.
function readEncoded(script: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", script], { stdio: "pipe" });
    let outText = "";
    let errText = "";
    const out = child.stdout.setEncoding("utf8");
    out.on("data", (c: unknown) => {
      outText += typeof c + ":" + String(c) + ";";
    });
    const err = child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: unknown) => {
      errText += typeof c + ":" + String(c) + ";";
    });
    void err;
    child.on("close", () => resolve(outText + " err " + errText));
  });
}

async function main(): Promise<void> {
  console.log("gunzip", await gunzipThrough(gzipSync(Buffer.from("payload"))));
  const file = path.join(os.tmpdir(), `scriptc-stream-construction-${process.pid}.txt`);
  fs.writeFileSync(file, "file text\n");
  console.log("file", JSON.stringify(await readFileStream(file)));
  fs.unlinkSync(file);
  console.log("run", JSON.stringify(await run("echo hi; echo warn >&2")));
  console.log("encoded", JSON.stringify(await readEncoded("printf hi; printf warn >&2")));
  for (const script of ["echo bad >&2; exit 3", "kill -TERM $$"]) {
    try {
      await run(script);
    } catch (e) {
      console.log("error", (e as Error).message);
    }
  }
}

void main();
