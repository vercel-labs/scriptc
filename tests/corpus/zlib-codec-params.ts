// The Brotli and zstd option surfaces beyond the plain level switches:
// every Brotli encoder parameter (mode, quality, window, block size, size
// hint, literal context modeling), both Brotli decoder parameters, zstd
// compression parameters with a dictionary and a pledged source size, and
// the zstd decompression window limit — through the one-shots, the callback
// and promisified forms, and the streams. Compressed bytes print where the
// parameter changes them; the rest print decoded text and lengths, and the
// invalid parameters print Node's error fields.
import * as zlib from "node:zlib";
import { Transform } from "node:stream";
import { promisify } from "node:util";

const text: string = "codec parameter payload ".repeat(40);
const size: number = Buffer.byteLength(text);
const dict: Buffer = Buffer.from("codec parameter payload");

function attempt(label: string, run: () => void): void {
  try {
    run();
    console.log(label, "ok");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    console.log(label, err.name, err.code, err.message);
  }
}

function show(label: string, value: Buffer): void {
  console.log(label, value.length, value.toString());
}

// Brotli: every documented encoder parameter at once, then both decoder
// parameters, each on data the parameter set compressed.
const tuned: Buffer = zlib.brotliCompressSync(text, {
  params: {
    [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
    [zlib.constants.BROTLI_PARAM_QUALITY]: 2,
    [zlib.constants.BROTLI_PARAM_LGWIN]: 18,
    [zlib.constants.BROTLI_PARAM_LGBLOCK]: 16,
    [zlib.constants.BROTLI_PARAM_SIZE_HINT]: size,
    [zlib.constants.BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING]: 1,
  },
});
console.log("brotli tuned", tuned.length, zlib.brotliDecompressSync(tuned).toString() === text);
show(
  "large window",
  zlib.brotliDecompressSync(tuned, {
    params: { [zlib.constants.BROTLI_DECODER_PARAM_LARGE_WINDOW]: true },
  }),
);
show(
  "ring buffer",
  zlib.brotliDecompressSync(tuned, {
    params: { [zlib.constants.BROTLI_DECODER_PARAM_DISABLE_RING_BUFFER_REALLOCATION]: 1 },
  }),
);
// Node clamps a quality above the maximum instead of rejecting it.
const clamped: Buffer = zlib.brotliCompressSync(text, {
  params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 99 },
});
console.log("clamped quality", zlib.brotliDecompressSync(clamped).toString() === text);
attempt("brotli unknown param", () => {
  zlib.brotliCompressSync(text, { params: { 999: 1 } });
});
attempt("brotli decoder param on compress", () => {
  zlib.brotliCompressSync(text, {
    params: { [zlib.constants.BROTLI_DECODER_PARAM_LARGE_WINDOW]: 1 },
  });
});
attempt("brotli encoder param on decompress", () => {
  zlib.brotliDecompressSync(tuned, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 2 } });
});
attempt("brotli maxOutputLength", () => {
  zlib.brotliCompressSync(text, { maxOutputLength: 4 });
});
attempt("brotli chunkSize", () => {
  zlib.brotliCompressSync(text, { chunkSize: 16 });
});

// zstd: compression parameters with a dictionary, a pledged source size
// and a small output chunk, decoded with the same dictionary and a window
// limit.
const compressed: Buffer = zlib.zstdCompressSync(text, {
  dictionary: dict,
  params: {
    [zlib.constants.ZSTD_c_compressionLevel]: 7,
    [zlib.constants.ZSTD_c_checksumFlag]: 1,
    [zlib.constants.ZSTD_c_strategy]: zlib.constants.ZSTD_btopt,
  },
  pledgedSrcSize: size,
  chunkSize: 128,
});
console.log("zstd tuned", compressed.length);
show("zstd dictionary", zlib.zstdDecompressSync(compressed, { dictionary: dict }));
show(
  "zstd window",
  zlib.zstdDecompressSync(compressed, {
    dictionary: dict,
    params: { [zlib.constants.ZSTD_d_windowLogMax]: 20 },
  }),
);
attempt("zstd without dictionary", () => {
  zlib.zstdDecompressSync(compressed);
});
attempt("zstd compression param on decompress", () => {
  zlib.zstdDecompressSync(compressed, {
    dictionary: dict,
    params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 },
  });
});

const compressBrotli = promisify(zlib.brotliCompress);
const decompressBrotli = promisify(zlib.brotliDecompress);
const compressZstd = promisify(zlib.zstdCompress);
const decompressZstd = promisify(zlib.zstdDecompress);

async function main(): Promise<void> {
  const brotli: Buffer = await compressBrotli(text, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 3, [zlib.constants.BROTLI_PARAM_LGWIN]: 17 },
  });
  const brotliBack: Buffer = await decompressBrotli(brotli, {
    params: { [zlib.constants.BROTLI_DECODER_PARAM_LARGE_WINDOW]: true },
  });
  console.log("promised brotli", brotli.length > 0, brotliBack.toString() === text);
  const zstd: Buffer = await compressZstd(text, { dictionary: dict, pledgedSrcSize: size });
  const zstdBack: Buffer = await decompressZstd(zstd, { dictionary: dict });
  console.log("promised zstd", zstd.length > 0, zstdBack.toString() === text);

  zlib.brotliCompress(
    text,
    { params: { [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_FONT } },
    (error, packed) => {
      console.log("callback brotli", error, zlib.brotliDecompressSync(packed).toString() === text);
      zlib.zstdCompress(text, { dictionary: dict }, (error2, packed2) => {
        console.log("callback zstd", error2, zlib.zstdDecompressSync(packed2, { dictionary: dict }).toString() === text);
        streams();
      });
    },
  );
}

function collect(stream: Transform): Promise<Buffer> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => parts.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(parts)));
  });
}

async function streams(): Promise<void> {
  const encoder: zlib.BrotliCompress = zlib.createBrotliCompress({
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 2, [zlib.constants.BROTLI_PARAM_LGWIN]: 17 },
    chunkSize: 128,
  });
  const packed: Promise<Buffer> = collect(encoder);
  encoder.end(text);
  const blob: Buffer = await packed;
  console.log("brotli stream", blob.length > 0, encoder.bytesWritten === size);
  const decoder: zlib.BrotliDecompress = zlib.createBrotliDecompress({
    params: { [zlib.constants.BROTLI_DECODER_PARAM_LARGE_WINDOW]: true },
  });
  const plain: Promise<Buffer> = collect(decoder);
  decoder.end(blob);
  show("brotli stream back", await plain);

  const zencoder: zlib.ZstdCompress = zlib.createZstdCompress({
    dictionary: dict,
    params: { [zlib.constants.ZSTD_c_compressionLevel]: 7 },
  });
  const zpacked: Promise<Buffer> = collect(zencoder);
  zencoder.end(text);
  const zblob: Buffer = await zpacked;
  const zdecompress: zlib.ZstdDecompress = zlib.createZstdDecompress({ dictionary: dict });
  const zplain: Promise<Buffer> = collect(zdecompress);
  zdecompress.end(zblob);
  show("zstd stream", await zplain);
  attempt("brotli stream param", () => {
    zlib.createBrotliDecompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 2 } });
  });
  attempt("zstd stream pledge", () => {
    zlib.createZstdCompress({ pledgedSrcSize: -1 });
  });
}

main();
