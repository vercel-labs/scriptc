// Writes complete before anything reads: the readable side holds output
// chunks only as the reader asks for them, so neither of two small writes
// waits on the readable queue (Node's writable and readable sides are
// independent). The stream then closes, and reading it back decompresses to
// the two payloads in order.

const encoder = new TextEncoder();
const compressor = new CompressionStream("gzip");
const writer = compressor.writable.getWriter();
await writer.write(encoder.encode("first:".repeat(600)));
console.log("first resolved");
await writer.write(encoder.encode("second:".repeat(600)));
console.log("second resolved");
await writer.close();
console.log("close resolved");
const reader = compressor.readable.getReader();
const compressed: Uint8Array[] = [];
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  compressed.push(value as Uint8Array);
}
const decompressor = new DecompressionStream("gzip");
const dwriter = decompressor.writable.getWriter();
const dreader = decompressor.readable.getReader();
const decoded = (async () => {
  let text = "";
  for (;;) {
    const { value, done } = await dreader.read();
    if (done) break;
    text += Buffer.from(value as Uint8Array).toString();
  }
  return text;
})();
for (const part of compressed) await dwriter.write(part);
await dwriter.close();
const text = await decoded;
console.log("roundtrip", text === "first:".repeat(600) + "second:".repeat(600));
