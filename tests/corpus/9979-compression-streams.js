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

const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
const u16 = new Uint16Array(bytes.buffer, 0, 4);
const dv = new DataView(bytes.buffer, 0, 8);
console.log(
  "views",
  hex(await run(new CompressionStream("gzip"), [bytes])),
  hex(await run(new CompressionStream("gzip"), [u16])),
  hex(await run(new CompressionStream("gzip"), [dv])),
);

const gz = await run(new CompressionStream("gzip"), [encoder.encode("hello world")]);
try {
  await run(new DecompressionStream("gzip"), [gz.slice(0, gz.length - 4)]);
  console.log("truncated accepted");
} catch (error) {
  console.log("truncated", error.name, JSON.stringify(error.message), error.code);
}
const junk = new Uint8Array(gz.length + 3);
junk.set(gz);
junk.set([1, 2, 3], gz.length);
try {
  await run(new DecompressionStream("gzip"), [junk]);
  console.log("junk accepted");
} catch (error) {
  console.log("junk", error.name, JSON.stringify(error.message), error.code);
}
try {
  await run(new DecompressionStream("gzip"), [gz, new Uint8Array([1, 2, 3])]);
  console.log("junk2 accepted");
} catch (error) {
  console.log("junk2", error.name, JSON.stringify(error.message), error.code);
}

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

// An empty chunk is a completed write: the stream accepts it and still
// compresses the chunks that follow.
const afterEmpty = await run(new CompressionStream("gzip"), [
  new Uint8Array(0),
  encoder.encode("after-empty"),
]);
console.log(
  "empty-first",
  hex(afterEmpty),
  decoder.decode(await run(new DecompressionStream("gzip"), [afterEmpty])),
);

// The invalid-format message carries the whole value, however long.
const longFormat = "x".repeat(400);
try {
  new CompressionStream(longFormat);
  console.log("long accepted");
} catch (error) {
  console.log("long", error.name, error.message.length, error.message.includes(longFormat), error.message);
}
