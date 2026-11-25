// The two zlib codec parameter error codes: a params key that names no
// parameter raises ERR_BROTLI_INVALID_PARAM / ERR_ZSTD_INVALID_PARAM (a
// RangeError whose message is the whole key and then Node's text), in every
// form that reads params: the stream classes and factories, the sync
// one-shots, and both codec directions. A value that is not a number is the
// type check instead, and the zstd direction check raises
// ERR_ZLIB_INITIALIZATION_FAILED; the valid parameters still compress.
const zlib = require("node:zlib");

function show(label, run) {
  try {
    const result = run();
    console.log(label, "ok", Buffer.isBuffer(result) ? result.length : typeof result);
  } catch (err) {
    const message = err.message;
    const shown = message.length > 80 ? `${message.length}:${message.slice(-48)}` : JSON.stringify(message);
    console.log(label, err.name, err.code, err instanceof RangeError, shown);
  }
}

const text = Buffer.from("codec parameters ".repeat(16));

// Brotli: every key that is not a parameter number 0..8 is invalid, in the
// compressor and the decompressor alike.
for (const key of ["9", "-1", "1.5", "x", "0.5", "1e3", "k".repeat(5000)]) {
  show(`brotli compress ${key.length > 40 ? "long" : JSON.stringify(key)}`, () =>
    zlib.brotliCompressSync(text, { params: { [key]: 1 } }),
  );
}
show("brotli decompress 9", () => zlib.brotliDecompressSync(zlib.brotliCompressSync(text), { params: { 9: 1 } }));
show("brotli compress class 9", () => new zlib.BrotliCompress({ params: { 9: 1 } }));
show("brotli decompress class 9", () => new zlib.BrotliDecompress({ params: { 9: 1 } }));
show("brotli decompress factory long", () => zlib.createBrotliDecompress({ params: { ["p".repeat(100000)]: 0 } }));
show("brotli value string", () => zlib.brotliCompressSync(text, { params: { 0: "1" } }));
show("brotli valid 0..8", () =>
  zlib.brotliCompressSync(text, { params: { 0: 1, 1: 5, 2: 22, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0 } }),
);
show("brotli value out of range", () => zlib.brotliCompressSync(text, { params: { 1: 99 } }));

// Zstd: a key above the mode's largest parameter is invalid; a known
// parameter from the other direction fails at the codec.
for (const key of ["9999", "-1", "4.5", "x", "0.5", "1e9", "z".repeat(5000)]) {
  show(`zstd compress ${key.length > 40 ? "long" : JSON.stringify(key)}`, () =>
    zlib.zstdCompressSync(text, { params: { [key]: 1 } }),
  );
}
show("zstd decompress 1000000", () => zlib.zstdDecompressSync(zlib.zstdCompressSync(text), { params: { 1000000: 0 } }));
show("zstd compress class 9999", () => new zlib.ZstdCompress({ params: { 9999: 1 } }));
show("zstd decompress class 9999", () => new zlib.ZstdDecompress({ params: { 9999: 1 } }));
show("zstd decompress factory long", () => zlib.createZstdDecompress({ params: { ["q".repeat(100000)]: 0 } }));
show("zstd value string", () => zlib.zstdCompressSync(text, { params: { 100: "3" } }));
show("zstd compress decompression param", () => zlib.zstdCompressSync(text, { params: { 0: 1 } }));
show("zstd decompress compression param", () => zlib.zstdDecompressSync(zlib.zstdCompressSync(text), { params: { 100: 1 } }));
show("zstd valid level", () => zlib.zstdCompressSync(text, { params: { 100: 5 } }));
show("zstd valid window", () => zlib.zstdDecompressSync(zlib.zstdCompressSync(text), { params: { 100: 27 } }));

// The callback forms build their stream synchronously, so an invalid
// parameter throws from the call itself; a valid one still calls back.
show("brotli callback invalid", () =>
  zlib.brotliCompress(text, { params: { 9: 1 } }, () => console.log("brotli callback ran")),
);
show("zstd callback invalid", () =>
  zlib.zstdCompress(text, { params: { 9999: 1 } }, () => console.log("zstd callback ran")),
);
zlib.brotliCompress(text, { params: { 1: 5 } }, (err, out) => {
  console.log("brotli callback", err === null, out !== undefined && out.length > 0);
  zlib.zstdCompress(text, { params: { 100: 5 } }, (err2, out2) => {
    console.log("zstd callback", err2 === null, out2 !== undefined && out2.length > 0);
  });
});
