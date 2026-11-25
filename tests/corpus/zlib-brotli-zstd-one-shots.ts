// node:zlib's Brotli and zstd one-shots and stream factories: every byte
// input Node takes, the option ladders, compressed bytes, errors, callback
// and promisified forms, and the create* / class spellings follow Node.
import * as zlib from "node:zlib";
import { promisify } from "node:util";

const text = Buffer.from("brotli and zstd one-shots, bytes and options: ".repeat(16));
const hello = new Uint8Array([104, 101, 108, 108, 111, 33]);
const view = new DataView(new Uint8Array([0, 0, 1, 2, 3, 4, 5]).buffer, 2, 4);
const hex = (value: Buffer): string => value.toString("hex");

function report(label: string, run: () => unknown): void {
  try {
    const value = run();
    console.log(label, "ok", Buffer.isBuffer(value) ? hex(value) : String(value));
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    console.log(label, err.name, err.code, err.errno, err.message);
  }
}

// Every static byte input: a string (UTF-8 encoded), a Buffer, a Uint8Array,
// a DataView with an offset, and an ArrayBuffer.
console.log("brotli empty", hex(zlib.brotliCompressSync("")));
console.log("brotli text", hex(zlib.brotliCompressSync(text)));
console.log("brotli uint8", hex(zlib.brotliCompressSync(hello)));
console.log("brotli view", hex(zlib.brotliCompressSync(view)));
console.log("brotli arraybuffer", hex(zlib.brotliCompressSync(hello.buffer)));
console.log("zstd empty", hex(zlib.zstdCompressSync("")));
console.log("zstd text", hex(zlib.zstdCompressSync(text)));
console.log("zstd uint8", hex(zlib.zstdCompressSync(hello)));
console.log("zstd view", hex(zlib.zstdCompressSync(view)));
console.log("zstd arraybuffer", hex(zlib.zstdCompressSync(hello.buffer)));

report("brotli roundtrip", () =>
  zlib.brotliDecompressSync(zlib.brotliCompressSync(text)).equals(text),
);
report("brotli text roundtrip", () =>
  zlib.brotliDecompressSync(zlib.brotliCompressSync("héllo wörld")).toString("utf8"),
);
report("zstd roundtrip", () => zlib.zstdDecompressSync(zlib.zstdCompressSync(text)).equals(text));
report("zstd view roundtrip", () =>
  zlib.zstdDecompressSync(zlib.zstdCompressSync(view)).toString("hex"),
);

// The parameter ladders: every value of the documented ranges compresses
// to Node's bytes.
for (const quality of [0, 1, 4, 6, 9, 11]) {
  const packed = zlib.brotliCompressSync(text, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality },
  });
  console.log("brotli quality", quality, packed.length, hex(packed));
}
for (const level of [1, 3, 9, 19]) {
  const packed = zlib.zstdCompressSync(text, {
    params: { [zlib.constants.ZSTD_c_compressionLevel]: level },
  });
  console.log("zstd level", level, packed.length, hex(packed));
}
console.log(
  "brotli text mode",
  hex(
    zlib.brotliCompressSync(text, {
      params: { [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT },
    }),
  ),
);
console.log(
  "brotli window",
  hex(
    zlib.brotliCompressSync(text, {
      params: {
        [zlib.constants.BROTLI_PARAM_LGWIN]: 10,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: text.length,
      },
    }),
  ),
);
console.log(
  "brotli dictionary",
  hex(zlib.brotliCompressSync("hello world", { dictionary: Buffer.from("hello world") })),
);
console.log(
  "brotli view dictionary",
  hex(zlib.brotliCompressSync("hello", { dictionary: hello })),
);
console.log(
  "brotli finishFlush",
  hex(zlib.brotliCompressSync(text, { flush: zlib.constants.BROTLI_OPERATION_FLUSH })),
);
console.log(
  "zstd checksum",
  hex(
    zlib.zstdCompressSync(text, {
      params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
    }),
  ),
);
console.log(
  "zstd window",
  hex(zlib.zstdCompressSync(text, { params: { [zlib.constants.ZSTD_c_windowLog]: 12 } })),
);
console.log(
  "zstd dictionary",
  hex(zlib.zstdCompressSync("hello world", { dictionary: Buffer.from("hello world") })),
);
console.log("zstd pledged", hex(zlib.zstdCompressSync(text, { pledgedSrcSize: text.length })));
console.log(
  "zstd finishFlush",
  hex(zlib.zstdCompressSync(text, { finishFlush: zlib.constants.ZSTD_e_flush })),
);
console.log(
  "brotli chunkSize",
  hex(zlib.brotliCompressSync(text, { chunkSize: 64 })),
);
console.log("zstd chunkSize", hex(zlib.zstdCompressSync(text, { chunkSize: 64 })));

// Option and input errors: Node's class, code, errno and message.
report("brotli unknown param", () => zlib.brotliCompressSync("x", { params: { 9999: 1 } }));
report("brotli quality above 11", () => zlib.brotliCompressSync("x", { params: { 1: 12 } }));
report("brotli string param", () => zlib.brotliCompressSync("x", { params: { 1: "5" } }));
report("brotli string dictionary", () => zlib.brotliCompressSync("x", { dictionary: "abc" }));
report("brotli flush range", () => zlib.brotliCompressSync(text, { flush: 4 }));
report("brotli reject type", () =>
  zlib.brotliCompressSync(text, { rejectGarbageAfterEnd: 1 }),
);
report("brotli maxOutputLength", () =>
  zlib.brotliCompressSync(text, { maxOutputLength: 8 }),
);
report("zstd unknown param", () => zlib.zstdCompressSync("x", { params: { 9999: 1 } }));
report("zstd out of range level", () =>
  zlib.zstdCompressSync(text, { params: { 100: 99 } }),
);
report("zstd string param", () => zlib.zstdCompressSync("x", { params: { 100: "3" } }));
report("zstd pledge mismatch", () =>
  zlib.zstdCompressSync(text, { pledgedSrcSize: 3 }),
);
report("zstd pledge string", () => zlib.zstdCompressSync(text, { pledgedSrcSize: "3" }));
report("zstd maxOutputLength", () => zlib.zstdCompressSync(text, { maxOutputLength: 8 }));
report("brotli number input", () => zlib.brotliCompressSync(JSON.parse("5")));
report("zstd number input", () => zlib.zstdCompressSync(JSON.parse("5")));
report("brotli garbage input", () =>
  zlib.brotliDecompressSync(Buffer.from("not brotli at all")),
);
report("zstd garbage input", () => zlib.zstdDecompressSync(Buffer.from("not zstd at all")));
report("brotli wrong dictionary", () =>
  zlib.brotliDecompressSync(zlib.brotliCompressSync("hello", { dictionary: hello }), {
    dictionary: Buffer.from("nope"),
  }),
);
report("zstd wrong dictionary", () =>
  zlib.zstdDecompressSync(zlib.zstdCompressSync("hello", { dictionary: hello }), {
    dictionary: Buffer.from("nope"),
  }),
);

const brotliCompress = promisify(zlib.brotliCompress);
const brotliDecompress = promisify(zlib.brotliDecompress);
const zstdCompress = promisify(zlib.zstdCompress);
const zstdDecompress = promisify(zlib.zstdDecompress);

async function promised(): Promise<void> {
  const packed = await brotliCompress(text, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 },
  });
  console.log("brotli promised", hex(packed));
  console.log("brotli promised roundtrip", (await brotliDecompress(packed)).equals(text));
  const compressed = await zstdCompress(text, {
    params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 },
  });
  console.log("zstd promised", hex(compressed));
  console.log("zstd promised roundtrip", (await zstdDecompress(compressed)).equals(text));
  for (const [label, run] of [
    ["brotli promised error", () => brotliDecompress(Buffer.from("nope"))],
    ["zstd promised error", () => zstdDecompress(Buffer.from("nope"))],
    [
      "brotli promised option error",
      () => brotliCompress(text, { params: { 1: 12 } }),
    ],
  ] as const) {
    try {
      await run();
      console.log(label, "resolved");
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      console.log(label, err.name, err.code, err.message);
    }
  }
}

function callbacks(): Promise<void> {
  return new Promise((resolve) => {
    zlib.brotliCompress(text, (error, packed) => {
      console.log("brotli callback", error, hex(packed));
      zlib.brotliDecompress(packed, { chunkSize: 64 }, (error2, plain) => {
        console.log("brotli callback options", error2, plain.equals(text));
        zlib.zstdCompress(text, { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }, (error3, compressed) => {
          console.log("zstd callback options", error3, hex(compressed));
          zlib.zstdDecompress(Buffer.from("nope"), (error4, result) => {
            console.log("zstd callback error", error4?.code, error4?.message, result);
            resolve();
          });
        });
      });
    });
  });
}

function factories(): Promise<void> {
  return new Promise((resolve) => {
    const compressor: zlib.BrotliCompress = zlib.createBrotliCompress({
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 },
    });
    console.log(
      "brotli factory",
      compressor instanceof zlib.BrotliCompress,
      compressor instanceof zlib.BrotliDecompress,
      compressor.bytesWritten,
    );
    const parts: Buffer[] = [];
    compressor.on("data", (chunk: Buffer) => parts.push(chunk));
    compressor.on("end", () => {
      const decompressor: zlib.BrotliDecompress = new zlib.BrotliDecompress();
      const back: Buffer[] = [];
      decompressor.on("data", (chunk: Buffer) => back.push(chunk));
      decompressor.on("end", () => {
        console.log("brotli class roundtrip", Buffer.concat(back).equals(text));
        zstdFactory(resolve);
      });
      decompressor.end(Buffer.concat(parts));
    });
    compressor.end(text);
  });
}

function zstdFactory(done: () => void): void {
  const compressor: zlib.ZstdCompress = zlib.createZstdCompress();
  const parts: Buffer[] = [];
  compressor.on("data", (chunk: Buffer) => parts.push(chunk));
  compressor.on("end", () => {
    const decompressor: zlib.ZstdDecompress = new zlib.ZstdDecompress();
    const back: Buffer[] = [];
    decompressor.on("data", (chunk: Buffer) => back.push(chunk));
    decompressor.on("end", () => {
      console.log("zstd class roundtrip", Buffer.concat(back).equals(text));
      done();
    });
    decompressor.end(Buffer.concat(parts));
  });
  compressor.end(text);
}

async function main(): Promise<void> {
  report("brotli factory bad param", () => zlib.createBrotliCompress({ params: { 9999: 1 } }));
  report("brotli factory flush", () => zlib.createBrotliCompress({ flush: 9 }));
  report("zstd factory bad param", () => zlib.createZstdCompress({ params: { 9999: 1 } }));
  report("zstd factory flush", () => zlib.createZstdDecompress({ flush: 9 }));
  await promised();
  await callbacks();
  await factories();
}

main();
