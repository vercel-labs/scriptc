// Typed twin of stdio-readable-size: the 'readable' + read(size) paused-mode
// surface through the typed stream declarations. read(4) fixes where the
// slices fall, so the drained text is chunk-boundary independent; the
// per-event counts are not printed for the same reason.
const input = process.stdin;
const chunks: string[] = [];
let paused = true;
console.log("initial", input.isPaused(), input.readableLength);
input.on("readable", () => {
  if (!input.isPaused()) paused = false;
  let chunk: Uint8Array | null;
  while ((chunk = input.read(4)) !== null) {
    chunks.push(Buffer.from(chunk).toString("ascii"));
  }
});
input.on("end", () => {
  console.log("paused in every 'readable'", paused);
  console.log("chunks", chunks.join("|"));
  console.log("drained", input.read() === null, input.readableLength);
});
