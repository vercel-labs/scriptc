// A large write with a reader already draining it completes: the write's
// backlog is fed to the engine as the reader asks for output, so neither
// side waits on the other. (A backlog that grew past its cap used to sit
// waiting for a pull that never came because the pull was already parked.)

const size = 4 * 1024 * 1024;
const payload = new Uint8Array(size);
for (let i = 0; i < size; i++) payload[i] = i & 0xff;
const stream = new CompressionStream("gzip");
const reader = stream.readable.getReader();
const writer = stream.writable.getWriter();
let compressed = 0;
const draining = (async () => {
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    compressed += value.length;
  }
  return compressed;
})();
await writer.write(payload);
console.log("write resolved");
await writer.close();
const total = await draining;
console.log("compressed", total > 0, total < size);
