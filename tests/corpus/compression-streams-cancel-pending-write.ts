// Cancelling the readable side settles a write that is waiting on the
// stream: the write's promise rejects with the cancel reason instead of
// staying pending forever.

const stream = new CompressionStream("gzip");
const reader = stream.readable.getReader();
const writer = stream.writable.getWriter();
// Incompressible input: the readable queue's bound holds only part of the
// output, so the write is genuinely waiting for a reader (a compressible
// payload completes before the cancel, and the two runtimes' timing would
// decide the answer).
const payload = new Uint8Array(8 * 1024 * 1024);
let state = 0x9e3779b9;
for (let i = 0; i < payload.length; i++) {
  state ^= state << 13;
  state >>>= 0;
  state ^= state >>> 17;
  state ^= state << 5;
  state >>>= 0;
  payload[i] = state & 0xff;
}
const pending = writer.write(payload).then(
  () => "resolved",
  (reason) => `rejected ${String(reason)}`,
);
await new Promise<void>((resolve) => setTimeout(resolve, 20));
await reader.cancel("stop");
console.log("write", await pending);
