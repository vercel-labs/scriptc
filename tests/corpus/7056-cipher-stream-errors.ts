// Cipher stream errors, close ordering and backpressure: a bad decrypt
// through pipeline() destroys every stage with the same error, a failed
// GCM authentication reaches 'error' after the data, destroy() closes the
// cipher's stream, and write() reports the high-water mark with 'drain'.
import * as crypto from "node:crypto";
import { Readable, Writable, pipeline } from "node:stream";

const key = Buffer.alloc(32, 5);
const iv = Buffer.alloc(16, 6);

function sealed(text: string): Buffer {
  const c = crypto.createCipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([c.update(text), c.final()]);
}

async function badDecrypt(): Promise<void> {
  const log: string[] = [];
  const source = Readable.from([sealed("secret message")]);
  const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.alloc(32, 8), iv);
  const sink = new Writable({
    write(_chunk: Buffer, _enc: string, cb: () => void) {
      cb();
    },
  });
  source.on("close", () => log.push("source close"));
  decipher.on("error", (e: NodeJS.ErrnoException) => log.push(`decipher error ${e.code}`));
  decipher.on("close", () => log.push("decipher close"));
  sink.on("error", (e: NodeJS.ErrnoException) => log.push(`sink error ${e.code}`));
  sink.on("close", () => log.push("sink close"));
  await new Promise<void>((resolve) => {
    pipeline(source, decipher, sink, (err: NodeJS.ErrnoException | null) => {
      log.push(`callback ${err?.code} ${err?.message}`);
      setImmediate(() => {
        console.log(log.join("\n"));
        console.log("destroyed:", source.destroyed, decipher.destroyed, sink.destroyed);
        resolve();
      });
    });
  });
}

async function gcmWithoutTag(): Promise<void> {
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.alloc(12));
  await new Promise<void>((resolve) => {
    d.on("data", (chunk: Buffer) => console.log("gcm data", chunk.length));
    d.on("error", (e: Error) => console.log("gcm error:", e.message));
    d.on("close", () => {
      console.log("gcm close");
      resolve();
    });
    d.end(Buffer.alloc(5));
  });
}

async function destroyMidway(): Promise<void> {
  const c = crypto.createCipheriv("aes-256-ctr", key, iv);
  await new Promise<void>((resolve) => {
    c.on("data", (chunk: Buffer) => {
      console.log("ctr data", chunk.length);
      c.destroy(new Error("stop"));
    });
    c.on("error", (e: Error) => console.log("ctr error:", e.message));
    c.on("close", () => {
      console.log("ctr close, destroyed:", c.destroyed);
      resolve();
    });
    c.write("0123456789");
    c.write("abcdef");
  });
}

async function backpressure(): Promise<void> {
  const c = crypto.createCipheriv("aes-256-ctr", key, iv);
  let received = 0;
  const slow = new Writable({
    highWaterMark: 1024,
    write(chunk: Buffer, _enc: string, cb: () => void) {
      received += chunk.length;
      setImmediate(cb);
    },
  });
  c.pipe(slow);
  const block = Buffer.alloc(4096, 1);
  let writes = 0;
  let fullAt = -1;
  while (writes < 64) {
    writes++;
    if (!c.write(block)) {
      fullAt = writes;
      break;
    }
  }
  console.log("write returned false at", fullAt);
  await new Promise<void>((resolve) => c.once("drain", () => resolve()));
  console.log("drained");
  await new Promise<void>((resolve) => {
    slow.on("finish", () => {
      console.log("received", received);
      resolve();
    });
    c.end();
  });
}

async function main(): Promise<void> {
  await badDecrypt();
  await gcmWithoutTag();
  await destroyMidway();
  await backpressure();
}
main();
