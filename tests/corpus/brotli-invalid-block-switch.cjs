// Brotli block-switch validation: a stream whose block switch names a type
// the metablock header never declared is rejected with
// BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH (-17) instead of decoding on in the
// malformed state (the decoder fix in Node 24.22.1, CVE-2026-111497). The sync
// call and the stream fed one byte at a time (Node's own reproducer, from
// test-zlib-invalid-input.js) both report the code, the errno and how much
// output came out first, and a valid stream still decodes.
const zlib = require("node:zlib");

const malformed = Buffer.from("200010414141fcffff07002228f00b60f7f41f000000", "hex");
const hello = Buffer.from("1b1600f88d946ede44558696206c6f350b32b54006543b", "hex");

console.log("constant", zlib.constants.BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH);

const show = (label, err) => console.log(label, err.name, err.code, err.errno, err.message);

try {
  zlib.brotliDecompressSync(malformed);
  console.log("sync", "no error");
} catch (err) {
  show("sync", err);
  console.log("sync instanceof Error", err instanceof Error);
}

const out = [];
const stream = zlib.createBrotliDecompress();
stream.on("data", (chunk) => out.push(chunk));
stream.on("error", (err) => {
  console.log("stream bytes", Buffer.concat(out).length);
  show("stream", err);
  valid();
});
for (let i = 0; i < malformed.length; i++) stream.write(malformed.subarray(i, i + 1));
stream.end();

function valid() {
  console.log("valid", JSON.stringify(zlib.brotliDecompressSync(hello).toString()));
  const round = zlib.brotliCompressSync("block switch round trip ".repeat(50));
  console.log("round trip", zlib.brotliDecompressSync(round).length);
}
