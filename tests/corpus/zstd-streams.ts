// node:zlib's zstd streams: the createZstdCompress/createZstdDecompress
// factories and the ZstdCompress/ZstdDecompress classes, their flush kinds
// (0..2, where zlib's streams take 0..5), reset, bytesWritten, and the
// decompressor's frames.
import * as zlib from "node:zlib";

const text: string = "streamed zstd payload ".repeat(40);

function compressStream(): void {
  const parts: Buffer[] = [];
  const stream: zlib.ZstdCompress = zlib.createZstdCompress({
    params: { [zlib.constants.ZSTD_c_compressionLevel]: 5 },
  });
  console.log(stream instanceof zlib.ZstdCompress, stream instanceof zlib.ZstdDecompress);
  console.log(stream instanceof zlib.Gzip);
  stream.on("data", (chunk: Buffer) => parts.push(chunk));
  stream.on("end", () => {
    const packed: Buffer = Buffer.concat(parts);
    console.log("stream", packed.equals(zlib.zstdCompressSync(text, {
      params: { [zlib.constants.ZSTD_c_compressionLevel]: 5 },
    })), stream.bytesWritten);
    const decompressor: zlib.ZstdDecompress = zlib.createZstdDecompress();
    const back: Buffer[] = [];
    decompressor.on("data", (chunk: Buffer) => back.push(chunk));
    decompressor.on("end", () => {
      console.log("decompressed", Buffer.concat(back).toString() === text);
      console.log("decompressor", decompressor instanceof zlib.ZstdDecompress, decompressor.bytesWritten);
      classes();
    });
    decompressor.end(packed);
  });
  stream.write(text.slice(0, 100));
  stream.flush(zlib.constants.ZSTD_e_continue, () => {
    console.log("flushed", parts.length > 0);
    stream.write(text.slice(100));
    stream.flush(() => {
      stream.end();
    });
  });
}

function classes(): void {
  const stream: zlib.ZstdCompress = new zlib.ZstdCompress();
  const parts: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => parts.push(chunk));
  stream.on("end", () => {
    console.log("class", Buffer.concat(parts).equals(zlib.zstdCompressSync("class built")));
    resetStream();
  });
  stream.end("class built");
}

function resetStream(): void {
  const stream: zlib.ZstdCompress = zlib.createZstdCompress();
  stream.reset();
  const parts: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => parts.push(chunk));
  stream.on("end", () => {
    console.log("after reset", zlib.zstdDecompressSync(Buffer.concat(parts)).toString());
    bounds();
  });
  stream.end("after reset");
}

function bounds(): void {
  const stream: zlib.ZstdCompress = zlib.createZstdCompress();
  for (const kind of [0, 1, 2, 3, 4, 99]) {
    try {
      stream.flush(kind, () => {});
      console.log("flush", kind, "ok");
    } catch (e) {
      const err: NodeJS.ErrnoException = e as NodeJS.ErrnoException;
      console.log("flush", kind, err.name, err.code, err.message);
    }
  }
  console.log(stream.bytesWritten);
  stream.destroy();
  try {
    zlib.createZstdCompress({ params: { 9999: 1 } });
  } catch (e) {
    const err: NodeJS.ErrnoException = e as NodeJS.ErrnoException;
    console.log("params", err.name, err.code, err.message);
  }
  try {
    zlib.createZstdDecompress({ flush: 9 });
  } catch (e) {
    const err: NodeJS.ErrnoException = e as NodeJS.ErrnoException;
    console.log("flush option", err.name, err.code, err.message);
  }
}

compressStream();
