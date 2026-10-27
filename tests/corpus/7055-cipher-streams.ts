// Cipheriv and Decipheriv as Transforms: pipeline() and stream/promises
// pipeline stages, pipe() chains, for await, write()/end() with 'data'
// events, setEncoding(), finished(), compose(), addAbortSignal(),
// stream/consumers, the stream properties, and the cipher's state after
// its stream flushed. A Hash reads through stream/consumers and for await
// the same way.
import * as crypto from "node:crypto";
import {
  PassThrough,
  Readable,
  Transform,
  Writable,
  addAbortSignal,
  compose,
  finished,
  pipeline,
} from "node:stream";
import { text } from "node:stream/consumers";
import { pipeline as pipelinePromise } from "node:stream/promises";

const key = Buffer.alloc(32, 7);
const iv = Buffer.alloc(16, 3);

function collector(into: Buffer[]): Writable {
  return new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      into.push(chunk);
      cb();
    },
  });
}

async function viaCallbackPipeline(): Promise<void> {
  const out: Buffer[] = [];
  await new Promise<void>((resolve) => {
    pipeline(
      Readable.from(["hello ", "cipher ", "streams"]),
      crypto.createCipheriv("aes-256-cbc", key, iv),
      crypto.createDecipheriv("aes-256-cbc", key, iv),
      collector(out),
      (err: Error | null) => {
        console.log("callback pipeline:", err ?? null, Buffer.concat(out).toString());
        resolve();
      },
    );
  });
}

async function viaPromisePipeline(): Promise<void> {
  const hash = crypto.createHash("sha256");
  await pipelinePromise(
    Readable.from([Buffer.from("abc"), Buffer.from("def")]),
    crypto.createCipheriv("aes-256-ctr", key, iv),
    new PassThrough(),
    hash,
  );
  console.log("promise pipeline digest:", hash.digest("hex"));
}

async function viaPipeAndForAwait(): Promise<void> {
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  const chain = Readable.from(["piped ", "through ", "two ciphers"]).pipe(cipher).pipe(decipher);
  let text = "";
  for await (const chunk of chain) text += chunk;
  console.log("pipe + for await:", text);
}

async function viaPipeIntoTransform(): Promise<void> {
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const upper = new Transform({
    transform(chunk: Buffer, _enc: string, cb: (err: Error | null, data?: Buffer) => void) {
      cb(null, Buffer.from(chunk.toString("hex").toUpperCase()));
    },
  });
  const out = cipher.pipe(upper);
  console.log("pipe answers its destination:", out === upper);
  cipher.end("into a transform");
  let hex = "";
  for await (const chunk of out) hex += chunk;
  console.log("pipe into transform:", hex);
}

async function viaPipelineArgumentOrder(): Promise<void> {
  const order: string[] = [];
  const source = (): string[] => {
    order.push("source");
    return ["x", "y"];
  };
  const cipherStage = (): crypto.Cipheriv => {
    order.push("cipher");
    return crypto.createCipheriv("aes-256-ctr", key, iv);
  };
  const hash = crypto.createHash("sha256");
  await pipelinePromise(
    source(),
    async function* (src: AsyncIterable<string>) {
      for await (const chunk of src) yield chunk.toUpperCase();
    },
    cipherStage(),
    hash,
  );
  console.log("pipeline argument order:", order.join(" "), hash.digest("hex"));
}

async function viaEvents(): Promise<void> {
  const cipher = crypto.createCipheriv("aes-128-cbc", Buffer.alloc(16, 1), Buffer.alloc(16, 2));
  cipher.setEncoding("hex");
  let hex = "";
  cipher.on("data", (chunk: string) => {
    hex += chunk;
  });
  await new Promise<void>((resolve) => {
    cipher.on("end", () => {
      console.log("events:", typeof hex, hex);
      resolve();
    });
    console.log("write returns:", cipher.write("first block of text"));
    cipher.end("and the rest");
  });
  // The stream's flush ran final(): the cipher is finished.
  try {
    cipher.update("more");
  } catch (e) {
    console.log("update after the stream:", (e as Error).message);
  }
  try {
    cipher.final();
  } catch (e) {
    console.log("final after the stream:", (e as NodeJS.ErrnoException).code, (e as Error).message);
  }
}

async function gcm(): Promise<void> {
  const gcmKey = Buffer.alloc(32, 9);
  const nonce = Buffer.alloc(12, 4);
  const enc = crypto.createCipheriv("aes-256-gcm", gcmKey, nonce);
  const parts: Buffer[] = [];
  enc.on("data", (chunk: Buffer) => parts.push(chunk));
  await new Promise<void>((resolve) => {
    enc.on("end", () => resolve());
    enc.end("authenticated message");
  });
  const tag = enc.getAuthTag();
  console.log("gcm tag length:", tag.length);
  const dec = crypto.createDecipheriv("aes-256-gcm", gcmKey, nonce);
  dec.setAuthTag(tag);
  let plain = "";
  for await (const chunk of Readable.from([Buffer.concat(parts)]).pipe(dec)) plain += chunk;
  console.log("gcm round trip:", plain);
}

async function viaFinishedAndProperties(): Promise<void> {
  const c = crypto.createDecipheriv("aes-256-ctr", key, iv);
  console.log("before:", c.readable, c.writable, c.writableEnded, c.destroyed, c.writableLength);
  const done = new Promise<void>((resolve) => {
    finished(c, (err?: NodeJS.ErrnoException | null) => {
      console.log("finished:", err ?? null, c.readableEnded, c.writableFinished);
      resolve();
    });
  });
  const parts: string[] = [];
  const reading = (async () => {
    for await (const chunk of c) parts.push(chunk.toString("hex"));
  })();
  c.write(Buffer.from("00112233", "hex"));
  c.end(Buffer.from("44556677", "hex"));
  console.log("ended:", c.writableEnded, c.writable);
  await reading;
  await done;
  console.log("for await over the cipher:", parts.join(""));
  await new Promise<void>((resolve) => setImmediate(resolve));
  console.log("after close:", c.destroyed, c.closed);
}

async function viaCompositions(): Promise<void> {
  const both = compose(
    crypto.createCipheriv("aes-256-cbc", key, iv),
    crypto.createDecipheriv("aes-256-cbc", key, iv),
  );
  let composed = "";
  both.on("data", (chunk: Buffer) => {
    composed += chunk.toString();
  });
  await new Promise<void>((resolve) => {
    both.on("end", () => resolve());
    both.end("composed");
  });
  console.log("compose:", composed);

  const ac = new AbortController();
  const aborted = addAbortSignal(ac.signal, crypto.createCipheriv("aes-256-ctr", key, iv));
  aborted.on("error", (e: Error) => console.log("addAbortSignal:", e.name));
  const closed = new Promise<void>((resolve) => aborted.on("close", () => resolve()));
  ac.abort();
  await closed;
  console.log("aborted cipher destroyed:", aborted.destroyed);

  const sealed = crypto.createCipheriv("aes-256-ctr", key, iv).update("through consumers");
  const plain = await text(Readable.from([sealed]).pipe(crypto.createDecipheriv("aes-256-ctr", key, iv)));
  console.log("consumers text:", plain);

  const hash = crypto.createHash("sha1");
  hash.setEncoding("hex");
  console.log("hash text:", await text(Readable.from(["abc"]).pipe(hash)));
  const md5 = crypto.createHash("md5");
  md5.end("xyz");
  for await (const digest of md5) console.log("hash for await:", (digest as Buffer).toString("hex"));
}

async function main(): Promise<void> {
  await viaFinishedAndProperties();
  await viaCompositions();
  await viaCallbackPipeline();
  await viaPromisePipeline();
  await viaPipeAndForAwait();
  await viaPipeIntoTransform();
  await viaPipelineArgumentOrder();
  await viaEvents();
  await gcm();
}
main();
