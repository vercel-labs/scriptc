// Wrapped streams and duplex pairs in bulk: each wrap registers a context on
// the source that the receiver's _read also references, and each pair holds
// its two sides, so every iteration builds a reference cycle. The program
// only reports what it built — the structural point is that thousands of
// them run and are torn down without a crash, and (in the sanitized lanes'
// LeakSanitizer check, tests/harness/stream-leaks.test.ts) without a leak.
import { PassThrough, Readable, duplexPair } from "node:stream";

let wrapped = 0;
let chunked = 0;
for (let i = 0; i < 500; i++) {
  const source = new PassThrough();
  const receiver = new Readable({ read() {} });
  const returned = receiver.wrap(source);
  source.write("chunk-" + i);
  const chunk = receiver.read();
  if (returned === receiver) wrapped++;
  if (chunk !== null && chunk.toString() === "chunk-" + i) chunked++;
  receiver.destroy();
  source.destroy();
}
console.log("wrapped", wrapped, "read", chunked);

let paired = 0;
let carried = 0;
for (let i = 0; i < 250; i++) {
  const [a, b] = duplexPair();
  a.write("pair-" + i);
  const chunk = b.read();
  if (a !== b && a.destroyed === false) paired++;
  if (chunk !== null && chunk.toString() === "pair-" + i) carried++;
  a.destroy();
  b.destroy();
}
console.log("paired", paired, "carried", carried);
