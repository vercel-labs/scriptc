// The globals' surface: both classes are constructors with readable and
// writable streams, brand and tag like Node's, and validate their format
// with Node's TypeError. Decompressing bytes that are not the format makes
// the readable reject with the zlib code.
for (const bad of [undefined, "zip", 1]) {
  try {
    new CompressionStream(bad);
  } catch (e) {
    console.log("format", String(bad), e.name, e.code, e.message);
  }
}
try {
  new DecompressionStream(null);
} catch (e) {
  console.log("format", String(null), e.name, e.code, e.message);
}
const cs = new CompressionStream("gzip");
const ds = new DecompressionStream("deflate");
const C = CompressionStream;
console.log(
  "brand",
  cs instanceof CompressionStream,
  ds instanceof DecompressionStream,
  cs instanceof DecompressionStream,
  cs instanceof TransformStream,
);
console.log("tag", Object.prototype.toString.call(cs), Object.prototype.toString.call(ds));
console.log("identity", cs.constructor === C, C === CompressionStream, typeof C);
console.log("members", Object.keys(cs).length, typeof cs.readable, typeof cs.writable);
const named = cs.readable;
console.log("readable", named instanceof ReadableStream);
const garbage = new DecompressionStream("gzip");
const reader = garbage.readable.getReader();
const writer = garbage.writable.getWriter();
writer.write(new Uint8Array([1, 2, 3, 4])).catch(() => {});
reader.read().then(
  () => console.log("garbage read"),
  (e) => console.log("garbage", e.name, e.code, JSON.stringify(e.message)),
);
