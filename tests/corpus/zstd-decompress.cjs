// node:zlib's zstd decompression: round trips of the frames zstdCompressSync
// writes, dictionaries, consecutive and skippable frames, trailing junk under
// both default and rejectGarbageAfterEnd, and the truncated and corrupt
// frames' errors, which Node reports with zlib's codes.
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

const packed = zlib.zstdCompressSync(text);
console.log("roundtrip", zlib.zstdDecompressSync(packed).equals(text));
console.log("empty", zlib.zstdDecompressSync(zlib.zstdCompressSync("")));
console.log("small", zlib.zstdDecompressSync(zlib.zstdCompressSync("a")).toString());
const dict = Buffer.from("hello world");
const packedDict = zlib.zstdCompressSync("hello world hello world", { dictionary: dict });
console.log("dictionary", zlib.zstdDecompressSync(packedDict, { dictionary: dict }).toString());
console.log("dictionary length", packedDict.length);
console.log("window", zlib.zstdDecompressSync(packed, { params: { [zlib.constants.ZSTD_d_windowLogMax]: 20 } }).length);
console.log("chunkSize", zlib.zstdDecompressSync(packed, { chunkSize: 64 }).length);
tryIt("chunkSize below range", () => zlib.zstdDecompressSync(packed, { chunkSize: 16 }));
console.log("finishFlush", zlib.zstdDecompressSync(packed, { finishFlush: zlib.constants.ZSTD_e_flush }).length);
console.log(
  "two frames",
  zlib.zstdDecompressSync(Buffer.concat([packed, zlib.zstdCompressSync("second")])).toString("latin1").length,
);
const skippable = Buffer.from([0x50, 0x2a, 0x4d, 0x18, 4, 0, 0, 0, 1, 2, 3, 4]);
console.log("skippable then frame", zlib.zstdDecompressSync(Buffer.concat([skippable, packed])).length);
console.log("trailing junk", zlib.zstdDecompressSync(Buffer.concat([packed, Buffer.from("junk")])).length);
console.log(
  "trailing skipped",
  zlib.zstdDecompressSync(Buffer.concat([packed, skippable])).length,
);
tryIt("empty input", () => zlib.zstdDecompressSync(Buffer.alloc(0)));
tryIt("truncated", () => zlib.zstdDecompressSync(packed.subarray(0, packed.length - 3)));
tryIt("garbage", () => zlib.zstdDecompressSync(Buffer.from("this is not a zstd frame")));
tryIt("reject junk", () =>
  zlib.zstdDecompressSync(Buffer.concat([packed, Buffer.from("junk")]), { rejectGarbageAfterEnd: true }),
);
tryIt("reject junk flag accepts clean", () => zlib.zstdDecompressSync(packed, { rejectGarbageAfterEnd: true }).length);
tryIt("wrong dictionary", () =>
  zlib.zstdDecompressSync(packedDict, { dictionary: Buffer.from("another dictionary") }).length,
);
tryIt("missing dictionary", () => zlib.zstdDecompressSync(packedDict).length);
tryIt("maxOutputLength", () => zlib.zstdDecompressSync(packed, { maxOutputLength: 16 }));
tryIt("decompress-only param", () => zlib.zstdDecompressSync(packed, { params: { 100: 27 } }));
tryIt("compress-only param", () => zlib.zstdDecompressSync(packed, { params: { 101: 3 } }));
tryIt("unknown param", () => zlib.zstdDecompressSync(packed, { params: { 4000: 1 } }));
tryIt("number input", () => zlib.zstdDecompressSync(JSON.parse("5")));

zlib.zstdDecompress(packed, (err, out) => {
  console.log("callback", err, out.equals(text));
  zlib.zstdDecompress(packedDict, { dictionary: dict }, (err2, out2) => {
    console.log("callback dictionary", err2, out2.toString());
    zlib.zstdDecompress(Buffer.from([1, 2, 3]), (err3, out3) => {
      // A failed call delivers no buffer: Node passes no value at all.
      console.log("callback error", err3.name, err3.code, err3.errno, err3.message, typeof out3);
      promised();
    });
  });
});

function promised() {
  const decompress = promisify(zlib.zstdDecompress);
  decompress(packed).then((out) => {
    console.log("promisified", out.equals(text));
    decompress(Buffer.alloc(0)).catch((e) => console.log("promisified error", e.code, e.message));
  });
}
