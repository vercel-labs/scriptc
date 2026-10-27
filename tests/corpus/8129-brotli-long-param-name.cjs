// A Brotli params key that names no parameter: ERR_BROTLI_INVALID_PARAM
// carries the whole key, however long, in Node's message.
const zlib = require("node:zlib");
for (const key of ["k".repeat(5000), "é".repeat(300) + "x", "9", "-1", "1.5", "x"]) {
  try {
    zlib.brotliCompressSync("data", { params: { [key]: 1 } });
    console.log("accepted", key.length);
  } catch (err) {
    const suffix = " is not a valid Brotli parameter";
    console.log(
      err.name,
      err.code,
      err.message.length,
      err.message === key + suffix,
      err.message.slice(-suffix.length - 3),
    );
  }
}
try {
  zlib.createBrotliDecompress({ params: { ["p".repeat(100000)]: 0 } });
} catch (err) {
  console.log(err.name, err.code, err.message.length, err.message.startsWith("pppp"));
}
