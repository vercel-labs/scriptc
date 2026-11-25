// An unsupported method call on a compression stream throws Node's "is not
// a function" TypeError and leaves the stream itself usable: the call gets a
// borrowed receiver and must not release it. (Before the fix the receiver's
// box was freed, so the next read of the stream answered undefined; under
// the sanitized lane it is a use-after-free.)

const compressor = new CompressionStream("gzip");
try {
  compressor.nope();
} catch (error) {
  console.log("call", error.name, error.message);
}
const reader = compressor.readable.getReader();
const writer = compressor.writable.getWriter();
const reading = (async () => {
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
  }
  return total;
})();
await writer.write(new TextEncoder().encode("payload"));
await writer.close();
console.log("read", (await reading) > 0);

const decompressor = new DecompressionStream("gzip");
try {
  decompressor.toString2();
} catch (error) {
  console.log("call2", error.name, error.message);
}
console.log("tag", Object.prototype.toString.call(decompressor));
