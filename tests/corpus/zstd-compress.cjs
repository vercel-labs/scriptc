// node:zlib's zstd compression over the vendored zstd 1.5.7, the version Node
// bundles: compressed bytes match Node's for the same parameters, and the
// options, errors, callback and promisified forms follow Node.
const zlib = require("node:zlib");
const { promisify } = require("node:util");

const text = Buffer.from("hello hello hello zstd ".repeat(20));
const hex = (b) => b.toString("hex");
const tryIt = (label, run) => {
  try {
    const r = run();
    console.log(label, "ok", Buffer.isBuffer(r) ? hex(r) : r);
  } catch (e) {
    console.log(label, e.name, e.code, e.errno, e.message);
  }
};

console.log(hex(zlib.zstdCompressSync("")), hex(zlib.zstdCompressSync("a")));
for (const level of [1, 2, 3, 9, 19]) {
  const out = zlib.zstdCompressSync(text, {
    params: { [zlib.constants.ZSTD_c_compressionLevel]: level },
  });
  console.log("level", level, out.length, hex(out));
}
console.log("window", hex(zlib.zstdCompressSync(text, { params: { [zlib.constants.ZSTD_c_windowLog]: 12 } })));
console.log("checksum", hex(zlib.zstdCompressSync(text, { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } })));
console.log("content size", hex(zlib.zstdCompressSync(text, { params: { [zlib.constants.ZSTD_c_contentSizeFlag]: 0 } })));
console.log("no dict id", hex(zlib.zstdCompressSync(text, { params: { [zlib.constants.ZSTD_c_dictIDFlag]: 0 } })));
console.log("dictionary", hex(zlib.zstdCompressSync("hello world", { dictionary: Buffer.from("hello world") })));
console.log(
  "arraybuffer dictionary",
  hex(zlib.zstdCompressSync("hello world", { dictionary: new Uint8Array([104, 101, 108, 108, 111]).buffer })),
);
console.log("pledged", hex(zlib.zstdCompressSync(text, { pledgedSrcSize: text.length })));
console.log("finishFlush", hex(zlib.zstdCompressSync(text, { finishFlush: zlib.constants.ZSTD_e_flush })));
console.log("uint8array input", hex(zlib.zstdCompressSync(new Uint8Array([1, 2, 3]))));
tryIt("pledge mismatch", () => zlib.zstdCompressSync(text, { pledgedSrcSize: 3 }));
tryIt("pledge string", () => zlib.zstdCompressSync(text, { pledgedSrcSize: "3" }));
tryIt("pledge fraction", () => zlib.zstdCompressSync(text, { pledgedSrcSize: 1.5 }));
tryIt("pledge negative", () => zlib.zstdCompressSync(text, { pledgedSrcSize: -1 }));
tryIt("unknown param", () => zlib.zstdCompressSync("x", { params: { 9999: 1 } }));
tryIt("decompress param on compress", () => zlib.zstdCompressSync("x", { params: { 100: 27 } }));
tryIt("out of range level", () => zlib.zstdCompressSync(text, { params: { 100: 99 } }));
tryIt("fractional level", () => zlib.zstdCompressSync(text, { params: { 100: 4.7 } }));
tryIt("negative level", () => zlib.zstdCompressSync(text, { params: { 100: -1 } }));
tryIt("repeated param", () => zlib.zstdCompressSync("x", { params: { 100: 3, "0100": 4 } }));
tryIt("fractional param key", () => zlib.zstdCompressSync("x", { params: { "100.5": 3 } }));
tryIt("string param value", () => zlib.zstdCompressSync("x", { params: { 100: "3" } }));
tryIt("params string", () => zlib.zstdCompressSync("x", { params: "3" }));
tryIt("params null", () => zlib.zstdCompressSync("x", { params: null }));
tryIt("string dictionary", () => zlib.zstdCompressSync("x", { dictionary: "abc" }));
tryIt("chunkSize", () => zlib.zstdCompressSync(text, { chunkSize: 10 }));
tryIt("flush above range", () => zlib.zstdCompressSync(text, { flush: 3 }));
tryIt("finishFlush above range", () => zlib.zstdCompressSync(text, { finishFlush: 99 }));
tryIt("rejectGarbageAfterEnd", () => zlib.zstdCompressSync(text, { rejectGarbageAfterEnd: 1 }));
tryIt("maxOutputLength", () => zlib.zstdCompressSync(text, { maxOutputLength: 8 }));
tryIt("number input", () => zlib.zstdCompressSync(JSON.parse("5")));

zlib.zstdCompress(text, (err, out) => {
  console.log("callback", err, hex(out));
  zlib.zstdCompress("abc", { params: { [zlib.constants.ZSTD_c_compressionLevel]: 2 } }, (err2, out2) => {
    console.log("callback options", err2, hex(out2));
    zlib.zstdCompress(text, { maxOutputLength: 8 }, (err3, out3) => {
      // A failed call delivers no buffer: Node passes no value at all.
      console.log("callback error", err3.name, err3.code, err3.message, typeof out3);
      promised();
    });
  });
});

function promised() {
  const compress = promisify(zlib.zstdCompress);
  compress("promised").then((out) => {
    console.log("promisified", hex(out));
    compress(text, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 9 } }).then((packed) => {
      console.log("promisified options", hex(packed));
    });
  });
}
