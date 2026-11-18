// CompressionStream and DecompressionStream: Node's formats (gzip, deflate,
// deflate-raw) over the vendored zlib, the TransformStream interface, the
// enum validation and a decompression error surfacing as a stream error.
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const run = async (stream, chunks) => {
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const writing = (async () => {
    for (const chunk of chunks) await writer.write(chunk);
    await writer.close();
  })().catch(() => {});
  const out = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(...value);
  }
  await writing;
  return Uint8Array.from(out);
};

const hex = (bytes) => Buffer.from(bytes).toString("hex");

for (const format of ["gzip", "deflate", "deflate-raw"]) {
  const compressed = await run(new CompressionStream(format), [encoder.encode("hello world")]);
  const restored = await run(new DecompressionStream(format), [compressed]);
  console.log("format", format, hex(compressed), decoder.decode(restored));
}

console.log("typeof", typeof CompressionStream, typeof DecompressionStream);
const stream = new CompressionStream("gzip");
console.log(
  "shape",
  stream.readable instanceof ReadableStream,
  stream.writable instanceof WritableStream,
  stream instanceof TransformStream,
  Object.prototype.toString.call(stream),
  stream.constructor.name,
  Object.prototype.toString.call(new DecompressionStream("deflate")),
);
console.log("string chunk", hex(await run(new CompressionStream("deflate-raw"), ["hello"])));

for (const format of [undefined, "br", 5]) {
  try {
    new CompressionStream(format);
    console.log("accepted", format);
  } catch (error) {
    console.log("invalid", error.name, error.message);
  }
}
try {
  new DecompressionStream("zip");
} catch (error) {
  console.log("invalid-decompress", error.name, error.message);
}

try {
  await run(new DecompressionStream("gzip"), [encoder.encode("not gzip")]);
  console.log("bad accepted");
} catch (error) {
  console.log("bad", error.name, JSON.stringify(error.message), error.code);
}
