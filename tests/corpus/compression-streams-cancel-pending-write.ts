// Cancelling the readable side settles a write that is waiting on the
// stream: the write's promise rejects with the cancel reason instead of
// staying pending forever.

const stream = new CompressionStream("gzip");
const reader = stream.readable.getReader();
const writer = stream.writable.getWriter();
const pending = writer.write(new Uint8Array(8 * 1024 * 1024)).then(
  () => "resolved",
  (reason) => `rejected ${String(reason)}`,
);
await new Promise<void>((resolve) => setTimeout(resolve, 20));
await reader.cancel("stop");
console.log("write", await pending);
