// A highly compressible chunk expands without a memory spike: the streams
// produce output as the reader pulls and pause when the readable queue is
// full, so a decompression bomb read slowly stays bounded (the harness
// measures the process's peak RSS for this program). Node's answers: the
// round trip is byte-exact, and the readable yields the engine's 16 KiB
// output chunks however slowly they are read.

const MB = 1024 * 1024;
const total = 32 * MB;
const compressor = new CompressionStream("gzip");
const cwriter = compressor.writable.getWriter();
const breader = compressor.readable.getReader();
const compressed: Uint8Array[] = [];
const collecting = (async () => {
  for (;;) {
    const { value, done } = await breader.read();
    if (done) break;
    compressed.push(value as Uint8Array);
  }
})();
const block = new Uint8Array(MB);
for (let i = 0; i < total / MB; i++) await cwriter.write(block);
await cwriter.close();
await collecting;
let length = 0;
for (const part of compressed) length += part.length;

const decompressor = new DecompressionStream("gzip");
const dwriter = decompressor.writable.getWriter();
const dreader = decompressor.readable.getReader();
let expanded = 0;
let chunks = 0;
let largest = 0;
const reading = (async () => {
  for (;;) {
    const { value, done } = await dreader.read();
    if (done) break;
    expanded += value.length;
    chunks += 1;
    if (value.length > largest) largest = value.length;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
})();
const joined = new Uint8Array(length);
let at = 0;
for (const part of compressed) {
  joined.set(part, at);
  at += part.length;
}
await dwriter.write(joined);
await dwriter.close();
await reading;
console.log("compressed", length < total, "expanded", expanded === total, "chunks", chunks, "largest", largest);
