// Object-mode streams in JavaScript: any value as a chunk through
// Readable, Writable, Duplex, Transform and PassThrough, pipe() and
// pipeline() between them, unshift(), the per-side modes and
// their high-water marks, and the encoding argument write() and end()
// hand to _write and _transform.
import { Duplex, PassThrough, Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

const show = (v) => (typeof v === "object" ? JSON.stringify(v) : `${typeof v}:${String(v)}`);

async function values() {
  const seen = [];
  await pipeline(
    Readable.from([1, "two", { three: 3 }, [4], true, 0, ""]),
    new Transform({
      objectMode: true,
      transform(chunk, enc, cb) {
        cb(null, { wrapped: chunk });
      },
    }),
    new Writable({
      objectMode: true,
      write(chunk, enc, cb) {
        seen.push(show(chunk.wrapped));
        cb();
      },
    }),
  );
  console.log("values:", seen.join(" "));
}

function lines() {
  let rest = "";
  const split = new Transform({
    readableObjectMode: true,
    transform(chunk, enc, cb) {
      const parts = (rest + chunk.toString()).split("\n");
      rest = parts.pop();
      for (const p of parts) this.push({ line: p, length: p.length });
      cb();
    },
    flush(cb) {
      if (rest) this.push({ line: rest, length: rest.length });
      cb();
    },
  });
  console.log("split modes:", split.readableObjectMode, split.writableObjectMode);
  split.on("data", (row) => console.log("line:", row.line, row.length));
  split.on("end", () => console.log("split end"));
  split.write("alpha\nbe");
  split.write("ta\ngamma");
  split.end();
}

function encodings() {
  const w = new Writable({
    objectMode: true,
    write(chunk, enc, cb) {
      console.log("write enc:", show(chunk), enc);
      cb();
    },
  });
  w.write(1, () => console.log("write cb"));
  w.write(2, null);
  w.write(3, "utf8");
  w.write("four", "latin1");
  w.write(5, "anything");
  w.end(6, () => console.log("end cb"));
  const t = new Transform({
    objectMode: true,
    transform(chunk, enc, cb) {
      console.log("transform enc:", show(chunk), enc);
      cb();
    },
  });
  t.write(7);
  t.end(8, "hex");
  const bytes = new Writable({
    write(chunk, enc, cb) {
      console.log("byte write:", chunk.toString("hex"), enc);
      cb();
    },
  });
  bytes.write("hi", "latin1");
  bytes.write("6869", "hex");
  try {
    bytes.write("x", "bogus");
  } catch (e) {
    console.log("byte encoding:", e.code);
  }
  bytes.end();
}

function unshiftFront() {
  const r = new Readable({ objectMode: true, read() {} });
  r.push({ id: 1 });
  r.push({ id: 2 });
  r.push(null);
  console.log("length:", r.readableLength, "hwm:", r.readableHighWaterMark);
  r.unshift({ id: 0 });
  r.on("data", (v) => console.log("after unshift:", show(v)));
  r.on("end", () => console.log("read end"));
  // strings stay strings on an object-mode side, whatever the encoding
  const strings = new Readable({ objectMode: true, read() {} });
  strings.push("b");
  strings.unshift("a");
  strings.push("6869", "hex");
  strings.push(null);
  strings.on("data", (v) => console.log("string entry:", show(v)));
}

function piped() {
  const src = new PassThrough({ objectMode: true });
  const echo = new Duplex({
    objectMode: true,
    read() {},
    write(chunk, enc, cb) {
      this.push({ echoed: chunk });
      cb();
    },
    final(cb) {
      this.push(null);
      cb();
    },
  });
  src.pipe(echo).on("data", (v) => console.log("piped:", show(v)));
  src.write({ n: 1 });
  src.write([2, 3]);
  src.end("last");
}

function byteModeValues() {
  const r = new Readable({ read() {} });
  r.on("error", (e) => console.log("byte push:", e.code));
  r.push(undefined);
  r.push(42);
}

async function forAwait() {
  const pt = new PassThrough({ objectMode: true, highWaterMark: 2 });
  const ok = [pt.write(1), pt.write(2), pt.write(3)];
  console.log("backpressure:", ok.join(" "), pt.writableLength);
  pt.end({ done: true });
  const got = [];
  for await (const v of pt) got.push(show(v));
  console.log("for await:", got.join(" "));
}

await values();
lines();
encodings();
unshiftFront();
piped();
byteModeValues();
await forAwait();
