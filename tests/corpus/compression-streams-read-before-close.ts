// Reading two decompressed chunks before the writer closes keeps flowing:
// each read pulls the engine for its next 16 KiB chunk, and a chunk that
// went straight to a waiting reader settles that pull (the readable queue
// never crosses its watermark). A pull left parked strands the second read.

const text = "abcdefghij".repeat((64 * 1024) / 10);
const compressor = new CompressionStream("gzip");
const cwriter = compressor.writable.getWriter();
const breader = compressor.readable.getReader();
const parts: Uint8Array[] = [];
const collecting = (async () => {
  for (;;) {
    const { value, done } = await breader.read();
    if (done) break;
    parts.push(value as Uint8Array);
  }
})();
await cwriter.write(new TextEncoder().encode(text));
await cwriter.close();
await collecting;
let length = 0;
for (const part of parts) length += part.length;
const joined = new Uint8Array(length);
let at = 0;
for (const part of parts) {
  joined.set(part, at);
  at += part.length;
}

const decompressor = new DecompressionStream("gzip");
const writer = decompressor.writable.getWriter();
const reader = decompressor.readable.getReader();
await writer.write(joined);
const first = await reader.read();
const second = await reader.read();
console.log("read before close", (first.value as Uint8Array).length, (second.value as Uint8Array).length);
const draining = (async () => {
  let rest = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    rest += value.length;
  }
  return rest;
})();
await writer.close();
const rest = await draining;
console.log("total", (first.value as Uint8Array).length + (second.value as Uint8Array).length + rest);
