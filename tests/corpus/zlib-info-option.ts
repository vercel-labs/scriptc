// Node's `info: true` convenience option: the one-shot compressors and
// decompressors answer { buffer, engine } in place of the Buffer, where the
// engine is the stream the call used. The sync form's engine is left open
// with bytesWritten set to the input length and a closed handle (later
// writes complete without transforming anything); the callback and
// promisified forms hand over an engine that has ended, finished and been
// destroyed, whose 'close' lands after the callback. Errors keep their
// Node shapes, and the plain and { info: false } forms still answer Buffers.
import * as zlib from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(zlib.gzip);
const deflateAsync = promisify(zlib.deflate);
const gunzipAsync = promisify(zlib.gunzip);

interface GzipInfo {
  buffer: Buffer;
  engine: zlib.Gzip;
}
interface DeflateInfo {
  buffer: Buffer;
  engine: zlib.Deflate;
}
interface BrotliInfo {
  buffer: Buffer;
  engine: zlib.BrotliCompress;
}
interface ZstdInfo {
  buffer: Buffer;
  engine: zlib.ZstdCompress;
}

type Engine = zlib.Gzip | zlib.Deflate | zlib.BrotliCompress | zlib.ZstdCompress;

/** The engine state Node's `info` result exposes, in a fixed order. */
function state(engine: Engine): string {
  return [
    "bytesWritten=" + engine.bytesWritten,
    "destroyed=" + engine.destroyed,
    "closed=" + engine.closed,
    "writable=" + engine.writable,
    "readable=" + engine.readable,
    "writableEnded=" + engine.writableEnded,
    "writableFinished=" + engine.writableFinished,
    "readableEnded=" + engine.readableEnded,
    "readableLength=" + engine.readableLength,
    "writableLength=" + engine.writableLength,
  ].join(" ");
}

const gzip = zlib.gzipSync("hello", { info: true }) as GzipInfo;
console.log("gzipSync", Object.keys(gzip as object).join(","), Buffer.isBuffer(gzip.buffer), gzip.buffer.length);
console.log("gzipSync hex", gzip.buffer.toString("hex"));
console.log("gzipSync engine", state(gzip.engine));

// The sync engine's handle is closed: the write is accepted, completes with
// no error, and never reaches the compressor.
console.log("gzipSync write", gzip.engine.write("zz"), gzip.engine.writableLength, gzip.engine.bytesWritten);

// Other options still apply next to info.
const level1 = zlib.gzipSync("hello", { level: 1, info: true }) as GzipInfo;
console.log("gzipSync level 1", level1.buffer.length > 0, state(level1.engine).startsWith("bytesWritten=5"));
const raw = zlib.deflateRawSync("hello", { info: true }) as { buffer: Buffer; engine: zlib.DeflateRaw };
console.log("deflateRawSync", raw.buffer.length > 0, raw.engine.bytesWritten);
const unzipped = zlib.unzipSync(gzip.buffer, { info: true }) as { buffer: Buffer; engine: zlib.Unzip };
console.log("unzipSync", unzipped.buffer.toString(), unzipped.engine.bytesWritten);

const brotli = zlib.brotliCompressSync("hello", { info: true }) as BrotliInfo;
console.log("brotliCompressSync", Buffer.isBuffer(brotli.buffer), brotli.buffer.length, state(brotli.engine));
const zstd = zlib.zstdCompressSync("hello", { info: true }) as ZstdInfo;
console.log("zstdCompressSync", Buffer.isBuffer(zstd.buffer), zstd.buffer.length, state(zstd.engine));

// Without it — or with info: false — the Buffer form is unchanged.
const plain = zlib.gzipSync("hello");
const off = zlib.gzipSync("hello", { info: false });
console.log("plain", Buffer.isBuffer(plain), plain.equals(gzip.buffer), Buffer.isBuffer(off), off.equals(gzip.buffer));

// The callback form hands over a finished engine, and its 'close' follows
// the callback; the promisified forms settle with the same record.
zlib.deflate("hello", { info: true }, (err, out) => {
  const info = out as DeflateInfo;
  console.log("deflate callback", err === null, Buffer.isBuffer(info.buffer), info.buffer.length);
  console.log("deflate callback engine", state(info.engine));
  let closes = 0;
  info.engine.on("close", () => {
    closes += 1;
    console.log("deflate close", closes, info.engine.destroyed);
    runPromises();
  });
});

async function runPromises(): Promise<void> {
  const info = (await deflateAsync("hello", { info: true })) as DeflateInfo;
  console.log("deflateAsync", Buffer.isBuffer(info.buffer), info.buffer.length, state(info.engine));
  const again = (await gzipAsync("hello", { info: true })) as GzipInfo;
  console.log("gzipAsync", Buffer.isBuffer(again.buffer), again.buffer.length, again.engine.destroyed);
  const plainAsync = await gzipAsync("hello");
  console.log("gzipAsync plain", Buffer.isBuffer(plainAsync), plainAsync.length);

  // Errors keep the sync, callback and promise shapes.
  try {
    zlib.inflateSync("not deflate", { info: true });
    console.log("inflateSync error none");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    console.log("inflateSync error", e.code, e.errno);
  }
  try {
    await gunzipAsync("not gzip", { info: true });
    console.log("gunzipAsync error none");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    console.log("gunzipAsync error", e.code, e.errno);
  }
  zlib.gunzip("not gzip", { info: true }, (err, out) => {
    const e = err as NodeJS.ErrnoException | null;
    console.log("gunzip callback error", e !== null && e.code, out === undefined);
  });
}
