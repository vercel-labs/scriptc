// Every zlib, Brotli and zstd stream class built with new and with its
// factory: each compressor's output decodes back through the matching
// decompressor class, factory streams are instances of that class, and
// bytesWritten counts the input bytes. Compressed bytes are
// build-dependent, so only decoded text and byte counts print.
import * as zlib from "node:zlib";
import { Transform } from "node:stream";

const text: string = "stream classes payload ".repeat(20);

function written(stream: Transform, input: string): Promise<Buffer> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => parts.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(parts)));
    stream.end(input);
  });
}

function read(stream: Transform, input: Buffer): Promise<Buffer> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => parts.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(parts)));
    stream.end(input);
  });
}

async function roundTrip(encoder: Transform, decoder: Transform): Promise<boolean> {
  const packed = await written(encoder, text);
  const back = await read(decoder, packed);
  return packed.length > 0 && back.toString() === text;
}

async function main(): Promise<void> {
  const deflate = new zlib.Deflate();
  const inflate = new zlib.Inflate();
  console.log(
    "deflate",
    await roundTrip(deflate, inflate),
    deflate.bytesWritten === Buffer.byteLength(text),
    inflate.bytesWritten > 0,
  );

  const raw = new zlib.DeflateRaw();
  const rawBack = new zlib.InflateRaw();
  console.log("deflateRaw", await roundTrip(raw, rawBack), rawBack.bytesWritten > 0);

  const gzip = new zlib.Gzip();
  const gunzip = new zlib.Gunzip();
  console.log("gzip", await roundTrip(gzip, gunzip), gunzip.bytesWritten > 0);

  const gzipAgain = new zlib.Gzip();
  const unzipGzip = new zlib.Unzip();
  console.log("unzip gzip", await roundTrip(gzipAgain, unzipGzip));

  const deflated = new zlib.Deflate();
  const unzipDeflate = new zlib.Unzip();
  console.log("unzip deflate", await roundTrip(deflated, unzipDeflate));

  const brotli = new zlib.BrotliCompress();
  const brotliBack = new zlib.BrotliDecompress();
  console.log("brotli", await roundTrip(brotli, brotliBack), brotliBack.bytesWritten > 0);

  const zstd = new zlib.ZstdCompress();
  const zstdBack = new zlib.ZstdDecompress();
  console.log("zstd", await roundTrip(zstd, zstdBack), zstdBack.bytesWritten > 0);

  const madeDeflate = zlib.createDeflate();
  const madeInflate = zlib.createInflate();
  const madeDeflateRaw = zlib.createDeflateRaw();
  const madeInflateRaw = zlib.createInflateRaw();
  const madeGzip = zlib.createGzip();
  const madeGunzip = zlib.createGunzip();
  const madeUnzip = zlib.createUnzip();
  const madeBrotliCompress = zlib.createBrotliCompress();
  const madeBrotliDecompress = zlib.createBrotliDecompress();
  const madeZstdCompress = zlib.createZstdCompress();
  const madeZstdDecompress = zlib.createZstdDecompress();
  console.log(
    "factories",
    madeDeflate instanceof zlib.Deflate,
    madeInflate instanceof zlib.Inflate,
    madeDeflateRaw instanceof zlib.DeflateRaw,
    madeInflateRaw instanceof zlib.InflateRaw,
    madeGzip instanceof zlib.Gzip,
    madeGunzip instanceof zlib.Gunzip,
    madeUnzip instanceof zlib.Unzip,
    madeBrotliCompress instanceof zlib.BrotliCompress,
    madeBrotliDecompress instanceof zlib.BrotliDecompress,
    madeZstdCompress instanceof zlib.ZstdCompress,
    madeZstdDecompress instanceof zlib.ZstdDecompress,
  );
  madeDeflate.close();
  madeInflate.close();
  madeDeflateRaw.close();
  madeInflateRaw.close();
  madeGzip.close();
  madeGunzip.close();
  madeUnzip.close();
  madeBrotliCompress.close();
  madeBrotliDecompress.close();
  madeZstdCompress.close();
  madeZstdDecompress.close();
  console.log(
    "closed",
    madeDeflate.destroyed,
    madeInflate.destroyed,
    madeDeflateRaw.destroyed,
    madeInflateRaw.destroyed,
    madeGzip.destroyed,
    madeGunzip.destroyed,
    madeUnzip.destroyed,
    madeBrotliCompress.destroyed,
    madeBrotliDecompress.destroyed,
    madeZstdCompress.destroyed,
    madeZstdDecompress.destroyed,
  );

  console.log(
    "names",
    zlib.Deflate.name,
    zlib.Inflate.name,
    zlib.DeflateRaw.name,
    zlib.InflateRaw.name,
    zlib.Gzip.name,
    zlib.Gunzip.name,
    zlib.Unzip.name,
    zlib.BrotliCompress.name,
    zlib.BrotliDecompress.name,
    zlib.ZstdCompress.name,
    zlib.ZstdDecompress.name,
  );
}

main();
