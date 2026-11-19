// Documented edge behaviors of the readable and writable state APIs that
// the corpus did not pin: decoder output split across pushes and reads,
// late setEncoding over a buffered stream, unshift in string mode,
// read(size) in byte and object mode, push/unshift encodings, writev
// batching through cork/uncork, setDefaultEncoding, and drain.
import { PassThrough, Readable, Writable } from "node:stream";

function log(...parts: unknown[]): void {
  console.log(parts.map((p) => String(p)).join(" "));
}

function collect(r: Readable): Promise<string[]> {
  return new Promise((resolve) => {
    const chunks: string[] = [];
    r.on("data", (c: string | Buffer) => chunks.push(typeof c === "string" ? c : c.toString("hex")));
    r.on("end", () => resolve(chunks));
  });
}

// A multi-byte character split across pushes, decoded by setEncoding.
{
  const r = new Readable({ read() {} });
  r.setEncoding("utf8");
  const bytes = Buffer.from("héllo wörld");
  r.push(bytes.subarray(0, 2));
  r.push(bytes.subarray(2, 8));
  r.push(bytes.subarray(8));
  r.push(null);
  const chunks = await collect(r);
  log("split decode", chunks.join("|"), r.readableEncoding);
}

// read(size) that splits a multi-byte character while decoding.
{
  const r = new Readable({ read() {} });
  r.push(Buffer.from("aé"));
  r.push(null);
  r.setEncoding("utf8");
  log("read1", JSON.stringify(r.read(1)));
  log("read more", JSON.stringify(r.read(1)));
  log("read rest", JSON.stringify(r.read()));
}

// setEncoding after data is already buffered.
{
  const r = new Readable({ read() {} });
  r.push(Buffer.from("ab"));
  r.setEncoding("hex");
  r.push(null);
  const chunks = await collect(r);
  log("late hex", chunks.join("|"), r.readableEncoding);
}

// unshift in string mode, then read.
{
  const r = new Readable({ read() {} });
  r.setEncoding("utf8");
  r.unshift("B");
  r.push("C");
  r.push(null);
  log("unshift str", JSON.stringify(r.read()), r.readableLength);
  log("unshift rest", JSON.stringify(r.read()));
}

// push(chunk, encoding) in byte mode, and push('') mid-stream.
{
  const r = new Readable({ read() {} });
  r.push("4142", "hex");
  r.push("");
  r.push("cd", "hex");
  r.push(null);
  const chunks = await collect(r);
  log("push hex", chunks.join(","), r.readableLength);
}

// read(size) in byte mode and larger than buffered, then read().
{
  const r = new Readable({ read() {} });
  r.push(Buffer.from([0xff, 0x00, 0x41]));
  r.push(null);
  const a = r.read(2);
  log("bytes read2", a === null ? "null" : Buffer.isBuffer(a) ? a.toString("hex") : typeof a);
  const b = r.read(4);
  log("bytes read rest", b === null ? "null" : Buffer.isBuffer(b) ? b.toString("hex") : typeof b);
  log("bytes eof", String(r.read()), r.readableEnded);
}

// read(size) in object mode answers up to size values.
{
  const r = Readable.from(["a", "b", "c"]);
  const first = r.read(2);
  log("object read(2)", Array.isArray(first) ? first.join(",") : String(first), r.readableLength);
  const rest = r.read();
  log("object read()", Array.isArray(rest) ? rest.join(",") : String(rest));
}

// isPaused across pause/resume and after end.
{
  const r = Readable.from(["a", "b"]);
  log("isPaused fresh", r.isPaused(), r.readableFlowing);
  r.pause();
  log("isPaused paused", r.isPaused(), r.readableFlowing);
  r.on("data", () => {});
  r.resume();
  await new Promise((resolve) => r.on("end", resolve));
  log("isPaused ended", r.isPaused(), r.readableFlowing, r.readableAborted);
}

// cork/uncork batches writes into one _writev call.
{
  const calls: string[] = [];
  const w = new Writable({
    write(c: Buffer, _e, cb) {
      calls.push(`w ${c.toString()}`);
      cb();
    },
    writev(chunks: { chunk: Buffer }[], cb) {
      calls.push(`v ${chunks.map((c) => c.chunk.toString()).join("+")}`);
      cb();
    },
  });
  w.cork();
  w.write("a");
  w.write("b");
  log("cork len", w.writableLength, w.writableCorked);
  w.uncork();
  w.end("c", () => log("end cb", calls.join(","), w.writableFinished));
}

// setDefaultEncoding decides how later string writes are encoded.
{
  const seen: string[] = [];
  const w = new Writable({
    decodeStrings: true,
    write(c: Buffer, _e, cb) {
      seen.push(c.toString("hex"));
      cb();
    },
  });
  w.setDefaultEncoding("hex");
  w.write("4142");
  w.end();
  await new Promise((resolve) => w.on("finish", resolve));
  log("default encoding", seen.join(","));
}

// The write return value and the drain that follows it.
{
  const w = new Writable({
    highWaterMark: 2,
    write(_c, _e, cb) {
      setTimeout(cb, 1);
    },
  });
  log("write1", w.write("aaaa"));
  log("write2", w.write("bbbb"));
  await new Promise((resolve) => w.once("drain", resolve));
  log("drained", w.writableLength);
  await new Promise((resolve) => w.end(resolve));
}

// pipe answers the destination; unpipe leaves the flowing state off.
{
  const r = Readable.from(["a"]);
  const p = new PassThrough();
  log("pipe returns", r.pipe(p) === p);
  r.unpipe(p);
  p.destroy();
  log("unpiped", r.readableFlowing);
}
