// A compression stream's writes complete on their own: a chunk produced while
// no reader has started waits in the readable queue and does not hold the
// writable side, and closing behind an empty write still completes. Both
// outcomes are read against a timer so a hang shows up as "blocked"/"hung"
// instead of a stuck program.
const enc = new TextEncoder();

const cs = new CompressionStream("gzip");
const writer = cs.writable.getWriter();
const reader = cs.readable.getReader();
await writer.write(enc.encode("hello"));
// Let the engine produce the first chunk, which arms the readable side's
// backpressure before the next write starts.
await new Promise((settle) => setTimeout(settle, 30));
const second = await Promise.race([
  writer.write(enc.encode("world")).then(() => "resolved"),
  new Promise<string>((settle) => setTimeout(() => settle("blocked"), 200)),
]);
console.log("write after the first chunk", second);
await writer.close();
let compressed = 0;
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  compressed += value.length;
}
console.log("compressed", compressed > 0);

const raw = new CompressionStream("deflate-raw");
const rawWriter = raw.writable.getWriter();
const rawReader = raw.readable.getReader();
const big = new Uint8Array(1024 * 1024);
let x = 0x12345678;
for (let i = 0; i < big.length; i++) {
  x ^= x << 13;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  x >>>= 0;
  big[i] = x & 0xff;
}
const draining = (async () => {
  let bytes = 0;
  for (;;) {
    const { value, done } = await rawReader.read();
    if (done) break;
    bytes += value.length;
  }
  return bytes;
})();
await rawWriter.write(big);
await new Promise((settle) => setTimeout(settle, 5));
const empty = rawWriter.write(new Uint8Array(0));
const closed = rawWriter.close();
const closeOutcome = await Promise.race([
  Promise.all([empty, closed]).then(() => "closed"),
  new Promise<string>((settle) => setTimeout(() => settle("hung"), 300)),
]);
console.log("empty write then close", closeOutcome);
console.log("raw bytes", (await draining) > 0);
