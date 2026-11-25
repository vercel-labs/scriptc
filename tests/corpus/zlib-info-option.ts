// Node's `info: true` convenience option: the one-shot compressors and
// decompressors answer { buffer, engine } in place of the Buffer, where the
// engine is the stream the call used. bytesWritten is the input the run
// consumed — a decoder stops at the end of its stream, so trailing bytes
// after it are not counted; the sync form's engine is left open with that
// count and a closed handle (later writes complete without transforming
// anything), and the callback and promisified forms hand over an engine that
// has ended, finished and been destroyed, whose 'close' lands after the
// callback. Errors keep their Node shapes, and the plain and { info: false }
// forms still answer Buffers.
import * as zlib from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(zlib.gzip);
const deflateAsync = promisify(zlib.deflate);
const gunzipAsync = promisify(zlib.gunzip);
const inflateAsync = promisify(zlib.inflate);

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

// A decoder consumes input up to its stream's end and leaves the rest, so
// bytesWritten is the consumed count and the trailing bytes are not counted.
// A gzip decoder treats zero padding after a member the same way. These
// inputs also pin that the record's buffer is the whole decoded output.
const deflated = zlib.deflateSync("hello");
const junk = Buffer.from("TRAILING");
const inflateInfo = zlib.inflateSync(Buffer.concat([deflated, junk]), { info: true }) as {
  buffer: Buffer;
  engine: zlib.Inflate;
};
console.log("inflateSync trailing", inflateInfo.buffer.toString(), inflateInfo.engine.bytesWritten, deflated.length);
const padInfo = zlib.unzipSync(Buffer.concat([gzip.buffer, Buffer.alloc(4)]), { info: true }) as {
  buffer: Buffer;
  engine: zlib.Unzip;
};
console.log("unzipSync padding", padInfo.buffer.toString(), padInfo.engine.bytesWritten, gzip.buffer.length);
const brotliTrailing = zlib.brotliDecompressSync(Buffer.concat([brotli.buffer, junk]), { info: true }) as {
  buffer: Buffer;
  engine: zlib.BrotliDecompress;
};
console.log("brotliDecompressSync trailing", brotliTrailing.buffer.toString(), brotliTrailing.engine.bytesWritten, brotli.buffer.length);
const zstdTrailing = zlib.zstdDecompressSync(Buffer.concat([zstd.buffer, junk]), { info: true }) as {
  buffer: Buffer;
  engine: zlib.ZstdDecompress;
};
console.log("zstdDecompressSync trailing", zstdTrailing.buffer.toString(), zstdTrailing.engine.bytesWritten, zstd.buffer.length);

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
  const trailingAsync = (await inflateAsync(Buffer.concat([deflated, junk]), { info: true })) as {
    buffer: Buffer;
    engine: zlib.Inflate;
  };
  console.log("inflateAsync trailing", trailingAsync.buffer.toString(), trailingAsync.engine.bytesWritten, deflated.length);

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
    // Nested so the two callbacks' order does not depend on which worker
    // finishes first; the engine's count is the same as the sync form's.
    zlib.inflate(Buffer.concat([deflated, junk]), { info: true }, (err2, out2) => {
      const info = out2 as { buffer: Buffer; engine: zlib.Inflate };
      console.log("inflate callback trailing", err2 === null, info.buffer.toString(), info.engine.bytesWritten, deflated.length);
    });
  });
}
