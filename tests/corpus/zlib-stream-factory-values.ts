// The Brotli and zstd stream factories read as values and called through
// the value: each call builds the stream over the zlib engine, and the
// program makes no other Brotli or zstd call, so the codec is connected by
// the factory value alone.
import * as zlib from "node:zlib";

const text: string = "stream factory value payload ".repeat(8);

function brotli(): void {
  const makeCompress = zlib.createBrotliCompress;
  const compressor = makeCompress();
  const packed: Buffer[] = [];
  compressor.on("data", (chunk: Buffer) => packed.push(chunk));
  compressor.on("end", () => {
    const makeDecompress = zlib.createBrotliDecompress;
    const decompressor = makeDecompress();
    const back: Buffer[] = [];
    decompressor.on("data", (chunk: Buffer) => back.push(chunk));
    decompressor.on("end", () => {
      console.log("brotli", packed.length > 0, Buffer.concat(back).toString() === text);
      zstd();
    });
    decompressor.end(Buffer.concat(packed));
  });
  compressor.end(text);
}

function zstd(): void {
  const makeCompress = zlib.createZstdCompress;
  const compressor = makeCompress();
  const packed: Buffer[] = [];
  compressor.on("data", (chunk: Buffer) => packed.push(chunk));
  compressor.on("end", () => {
    const makeDecompress = zlib.createZstdDecompress;
    const decompressor = makeDecompress();
    const back: Buffer[] = [];
    decompressor.on("data", (chunk: Buffer) => back.push(chunk));
    decompressor.on("end", () => {
      console.log("zstd", packed.length > 0, Buffer.concat(back).toString() === text);
    });
    decompressor.end(Buffer.concat(packed));
  });
  compressor.end(text);
}

brotli();
