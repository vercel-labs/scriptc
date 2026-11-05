// Option callbacks that keep their `callback` argument: a Writable whose
// write() keeps every third callback and calls it later, a write that
// calls its callback and keeps it (`cb(); keep(cb)`) and calls it again
// after later writes (ERR_MULTIPLE_CALLBACK), and a Transform that calls
// back synchronously, from setImmediate, and from a promise. Every write
// and transform completes in Node's order. Every write and writev call
// receives the same callback, as in Node (a Set, a WeakSet and a WeakMap
// find it again); a transform call receives a new one each time.
import { Transform, Writable } from "node:stream";

type Done = (error?: Error | null) => void;

const kept: Done[] = [];
const log: string[] = [];

const deferred = new Writable({
  highWaterMark: 4,
  write(chunk: Buffer, _encoding: string, callback: Done) {
    const text = chunk.toString();
    if (Number(text) % 3 === 0) {
      kept.push(callback);
      log.push(`kept ${text}`);
      setImmediate(() => {
        const cb = kept.shift();
        log.push(`late ${text}`);
        if (cb) cb();
      });
      return;
    }
    log.push(`write ${text}`);
    callback();
  },
});
for (let i = 1; i <= 10; i++) {
  deferred.write(String(i), () => log.push(`done ${i}`));
}
deferred.end(() => {
  console.log(log.join("\n"));
  twice();
});

function twice(): void {
  let saved: Done | null = null;
  const w = new Writable({
    write(chunk: Buffer, _encoding: string, callback: Done) {
      const text = chunk.toString();
      console.log("twice write", text);
      callback();
      if (text === "a") saved = callback;
    },
  });
  w.on("error", (error: Error & { code?: string }) => {
    console.log("twice error", error.code);
  });
  w.write("a");
  w.write("b");
  w.write("c");
  setImmediate(() => {
    const cb = saved;
    if (cb) cb();
    setImmediate(transforms);
  });
}

function transforms(): void {
  let n = 0;
  const t = new Transform({
    transform(chunk: Buffer, _encoding: string, callback: (error?: Error | null, data?: Buffer) => void) {
      const k = n++;
      const out = Buffer.from(`[${chunk.toString()}]`);
      if (k % 3 === 0) callback(null, out);
      else if (k % 3 === 1) setImmediate(() => callback(null, out));
      else Promise.resolve().then(() => callback(null, out));
    },
  });
  const parts: string[] = [];
  t.on("data", (chunk: Buffer) => parts.push(chunk.toString()));
  t.on("end", () => {
    console.log("transform", parts.join(""));
    weakKeys();
  });
  for (let i = 0; i < 9; i++) t.write(String(i));
  t.end();
}

function weakKeys(): void {
  const seen = new WeakSet<Done>();
  const notes = new WeakMap<Done, string>();
  const held = new Set<Done>();
  const w = new Writable({
    write(chunk: Buffer, _encoding: string, callback: Done) {
      const text = chunk.toString();
      console.log("weak write", text, seen.has(callback), notes.get(callback) ?? "none", held.has(callback));
      seen.add(callback);
      notes.set(callback, text);
      if (text === "q") held.add(callback);
      callback();
    },
  });
  for (const text of ["p", "q", "r", "s"]) w.write(text);
  w.end(batches);
}

function batches(): void {
  const seen = new WeakSet<Done>();
  let first: Done | null = null;
  const w = new Writable({
    writev(chunks: Array<{ chunk: Buffer }>, callback: Done) {
      const text = chunks.map((c) => c.chunk.toString()).join("");
      console.log("writev", text, seen.has(callback), first === callback);
      seen.add(callback);
      if (first === null) first = callback;
      setImmediate(() => callback());
    },
  });
  w.write("a");
  w.write("b");
  w.write("c");
  w.end(weakTransform);
}

function weakTransform(): void {
  type TransformDone = (error?: Error | null, data?: Buffer) => void;
  const seen = new WeakSet<TransformDone>();
  const held = new Set<TransformDone>();
  const t = new Transform({
    transform(chunk: Buffer, _encoding: string, callback: TransformDone) {
      const text = chunk.toString();
      console.log("weak transform", text, seen.has(callback), held.has(callback));
      seen.add(callback);
      if (text === "x") held.add(callback);
      callback(null, chunk);
    },
  });
  t.resume();
  t.on("end", () => console.log("weak transform end"));
  for (const text of ["x", "y", "z"]) t.write(text);
  t.end();
}
