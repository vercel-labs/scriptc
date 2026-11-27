// Streams dropped without being closed free what they hold: a discarded
// CompressionStream or DecompressionStream keeps no engine memory after a
// collection (the sanitized lane runs the corpus under LeakSanitizer, where
// an engine an abandoned stream left behind shows up as a leak). Each round
// writes one small chunk, drops the pair without closing it, and the run
// yields to the event loop so a checkpoint can collect what it dropped.

const rounds = 200;
for (let i = 0; i < rounds; i++) {
  const compressor = new CompressionStream("gzip");
  const writer = compressor.writable.getWriter();
  void writer.write(new Uint8Array(4096)).catch(() => {});
  const decompressor = new DecompressionStream("deflate");
  const dreader = decompressor.writable.getWriter();
  void dreader.write(new Uint8Array(512)).catch(() => {});
  if (i % 20 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
await new Promise<void>((resolve) => setTimeout(resolve, 0));
console.log("abandoned", rounds);
