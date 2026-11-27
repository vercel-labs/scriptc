// A write larger than the backlog cap completes before any reader starts:
// the compressed output is tiny, so the engine drains the whole backlog into
// the readable queue's bound and the writable side resolves, as it does in
// Node. Closing first and reading afterwards sees the same bytes.

const size = 2 * 1024 * 1024;
const payload = new Uint8Array(size);
const compressor = new CompressionStream("gzip");
const writer = compressor.writable.getWriter();
await writer.write(payload);
console.log("write resolved");
await writer.close();
console.log("close resolved");
const reader = compressor.readable.getReader();
let compressed = 0;
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  compressed += value.length;
}
console.log("read", compressed > 0, compressed < size);
