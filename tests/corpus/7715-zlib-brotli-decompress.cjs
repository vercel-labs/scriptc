// zlib's Brotli decompression: fixed blobs Node produced, Brotli's own
// error codes (ERR_ + the decoder's error name) and zlib's for truncated
// input, trailing data, maxOutputLength, dictionaries, the decoder
// parameters, and the callback, promisified and stream forms.
const zlib = require("node:zlib");
const { promisify } = require("node:util");
const { pipeline, Readable, Writable } = require("node:stream");

const hello = Buffer.from("1b1600f88d946ede44558696206c6f350b32b54006543b", "hex");
const repeated = Buffer.from("1b8713f825f0e2b14020680100", "hex");
const withDictionary = Buffer.from("1b0a00f8250002980820", "hex");
const tryIt = (label, run) => {
  try {
    const r = run();
    console.log(label, "ok", Buffer.isBuffer(r) ? r.length + " " + r.toString().slice(0, 24) : r);
  } catch (e) {
    console.log(label, e.name, e.code, e.errno, e.message);
  }
};

tryIt("hello", () => zlib.brotliDecompressSync(hello));
tryIt("repeated", () => zlib.brotliDecompressSync(repeated));
tryIt("string input", () => zlib.brotliDecompressSync("abc"));
tryIt("arraybuffer input", () => zlib.brotliDecompressSync(hello.buffer.slice(hello.byteOffset, hello.byteOffset + hello.length)));
for (const hex of ["ff", "ffffffff", "ce", "0b008061", "3b00", "06", "2f", "1bffff00ffffffffffff"]) {
  tryIt(hex, () => zlib.brotliDecompressSync(Buffer.from(hex, "hex")));
}
tryIt("truncated", () => zlib.brotliDecompressSync(hello.subarray(0, 10)));
tryIt("trailing data", () => zlib.brotliDecompressSync(Buffer.concat([hello, Buffer.from("junk")])));
tryIt("trailing data rejected", () => zlib.brotliDecompressSync(Buffer.concat([hello, Buffer.from("junk")]), { rejectGarbageAfterEnd: true }));
tryIt("maxOutputLength", () => zlib.brotliDecompressSync(repeated, { maxOutputLength: 100 }));
tryIt("small chunks", () => zlib.brotliDecompressSync(repeated, { chunkSize: 64 }));
tryIt("partial with flush", () => zlib.brotliDecompressSync(hello.subarray(0, 8), { finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH }));
tryIt("dictionary", () => zlib.brotliDecompressSync(withDictionary, { dictionary: Buffer.from("hello world") }));
tryIt("missing dictionary", () => zlib.brotliDecompressSync(withDictionary));
tryIt("large window", () => zlib.brotliDecompressSync(hello, { params: { [zlib.constants.BROTLI_DECODER_PARAM_LARGE_WINDOW]: 1 } }));
tryIt("encoder param", () => zlib.brotliDecompressSync(hello, { params: { [zlib.constants.BROTLI_PARAM_LGWIN]: 10 } }));
tryIt("round trip", () => zlib.brotliDecompressSync(zlib.brotliCompressSync("round trip ".repeat(100))).toString() === "round trip ".repeat(100));

zlib.brotliDecompress(hello, (err, out) => {
  console.log("callback", err, out.toString());
  zlib.brotliDecompress(Buffer.from([1, 2, 3]), (err2) => {
    console.log("callback error", err2.code, err2.errno, err2.message);
    promised();
  });
});

function promised() {
  const decompress = promisify(zlib.brotliDecompress);
  decompress(repeated, { maxOutputLength: 10 }).catch((err) => {
    console.log("promisified", err.code, err.message);
    streams();
  });
}

function streams() {
  const out = [];
  const stream = zlib.createBrotliDecompress();
  console.log(stream instanceof zlib.BrotliDecompress, stream instanceof zlib.BrotliCompress);
  stream.on("data", (chunk) => out.push(chunk));
  stream.on("end", () => {
    console.log("stream", Buffer.concat(out).toString(), stream.bytesWritten);
    const bad = new zlib.BrotliDecompress();
    bad.on("error", (err) => {
      console.log("stream error", err.code, err.errno, err.message);
      piped();
    });
    bad.write(Buffer.from("ffff", "hex"));
    bad.end();
  });
  stream.write(hello.subarray(0, 5));
  stream.end(hello.subarray(5));
}

function piped() {
  const sink = [];
  pipeline(
    Readable.from([Buffer.from("one "), Buffer.from("two "), Buffer.from("three")]),
    zlib.createBrotliCompress(),
    zlib.createBrotliDecompress(),
    new Writable({
      write(chunk, _encoding, callback) {
        sink.push(chunk);
        callback();
      },
    }),
    (err) => {
      console.log("pipeline", err, Buffer.concat(sink).toString());
      try {
        new zlib.BrotliDecompress({ params: { 3: 1 } });
      } catch (e) {
        console.log(e.code, e.message);
      }
    },
  );
}
