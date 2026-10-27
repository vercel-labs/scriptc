// zlib's Brotli compression over the vendored brotli 1.2.0, the version
// Node bundles: compressed bytes match Node's for the same parameters, and
// the options, errors, callback, promisified and stream forms follow Node.
const zlib = require("node:zlib");
const { promisify } = require("node:util");

const text = Buffer.from("hello hello hello brotli ".repeat(20));
const hex = (b) => b.toString("hex");
const tryIt = (label, run) => {
  try {
    const r = run();
    console.log(label, "ok", Buffer.isBuffer(r) ? hex(r) : r);
  } catch (e) {
    console.log(label, e.name, e.code, e.errno, e.message);
  }
};

console.log(hex(zlib.brotliCompressSync("")), hex(zlib.brotliCompressSync("a")));
for (const quality of [0, 1, 4, 5, 9, 11]) {
  const out = zlib.brotliCompressSync(text, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality } });
  console.log("quality", quality, out.length, hex(out));
}
console.log("text mode", hex(zlib.brotliCompressSync(text, { params: { [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT } })));
console.log("font mode", hex(zlib.brotliCompressSync(text, { params: { [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_FONT } })));
console.log(
  "window",
  hex(zlib.brotliCompressSync(text, {
    params: { [zlib.constants.BROTLI_PARAM_LGWIN]: 10, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: text.length },
  })),
);
console.log("dictionary", hex(zlib.brotliCompressSync("hello world", { dictionary: Buffer.from("hello world") })));
console.log("arraybuffer dictionary", hex(zlib.brotliCompressSync("hello world", { dictionary: new Uint8Array([104, 101, 108, 108, 111]).buffer })));
console.log("finishFlush", hex(zlib.brotliCompressSync("hello", { finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH })));
tryIt("boolean param", () => zlib.brotliCompressSync("x", { params: { [zlib.constants.BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING]: true } }));
tryIt("fractional quality", () => zlib.brotliCompressSync("hello hello hello", { params: { 1: 4.7 } }));
tryIt("negative quality", () => zlib.brotliCompressSync("hello hello hello", { params: { 1: -1 } }));
tryIt("quality above 11", () => zlib.brotliCompressSync("hello hello hello", { params: { 1: 12 } }));
tryIt("unknown param", () => zlib.brotliCompressSync("x", { params: { 9999: 1 } }));
tryIt("param 9", () => zlib.brotliCompressSync("x", { params: { 9: 0 } }));
tryIt("repeated param", () => zlib.brotliCompressSync("x", { params: { 1: 5, "01": 4 } }));
tryIt("fractional param key", () => zlib.brotliCompressSync("x", { params: { "1.5": 5 } }));
tryIt("negative param key", () => zlib.brotliCompressSync("x", { params: { "-1": 5 } }));
tryIt("string param value", () => zlib.brotliCompressSync("x", { params: { 1: "5" } }));
tryIt("string dictionary", () => zlib.brotliCompressSync("x", { dictionary: "abc" }));
tryIt("chunkSize", () => zlib.brotliCompressSync(text, { chunkSize: 10 }));
tryIt("flush", () => zlib.brotliCompressSync(text, { flush: 4 }));
tryIt("finishFlush range", () => zlib.brotliCompressSync(text, { finishFlush: 99 }));
tryIt("rejectGarbageAfterEnd", () => zlib.brotliCompressSync(text, { rejectGarbageAfterEnd: 1 }));
tryIt("maxOutputLength", () => zlib.brotliCompressSync(text, { maxOutputLength: 8 }));
tryIt("number input", () => zlib.brotliCompressSync(JSON.parse("5")));

zlib.brotliCompress(text, (err, out) => {
  console.log("callback", err, hex(out));
  zlib.brotliCompress("abc", { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 2 } }, (err2, out2) => {
    console.log("callback options", err2, hex(out2));
    promised();
  });
});

function promised() {
  const compress = promisify(zlib.brotliCompress);
  compress("promised").then((out) => {
    console.log("promisified", hex(out));
    streams();
  });
}

function streams() {
  const chunks = [];
  const stream = zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } });
  console.log(stream instanceof zlib.BrotliCompress, stream instanceof zlib.Gzip);
  stream.on("data", (chunk) => chunks.push(chunk));
  stream.on("end", () => {
    console.log("stream", hex(Buffer.concat(chunks)), stream.bytesWritten);
    const second = new zlib.BrotliCompress();
    const parts = [];
    second.on("data", (chunk) => parts.push(chunk));
    second.on("end", () => {
      console.log("class", hex(Buffer.concat(parts)));
      try { zlib.createBrotliCompress({ params: { 99: 1 } }); } catch (e) { console.log(e.code, e.message); }
      try { zlib.createBrotliCompress({ flush: 9 }); } catch (e) { console.log(e.code, e.message); }
    });
    second.reset();
    second.end("reset first");
  });
  stream.write(text.subarray(0, 100));
  stream.flush(() => {
    console.log("flushed", chunks.length > 0);
    stream.end(text.subarray(100));
  });
}
