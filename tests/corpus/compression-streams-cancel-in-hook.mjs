// A read that settles while the stream's engine runs can run an async_hooks
// callback that cancels the reader. The engine's step then re-checks its
// controller and codec before using them again (the cancel cleared the first
// and released the second); the stream's later output has nowhere to go, so
// the write's own settlement is left to the stream's error path. (Under the
// sanitized lane the old path used the freed state.)

import { createHook } from "node:async_hooks";
import { gzipSync } from "node:zlib";

let pending = null;
const hook = createHook({
  promiseResolve() {
    if (pending === null) return;
    const reader = pending;
    pending = null;
    void reader.cancel("hooked").catch(() => {});
  },
});
const stream = new DecompressionStream("gzip");
pending = stream.readable.getReader();
void pending.read().catch(() => {});
hook.enable();
try {
  // Large enough that the engine keeps producing output after the read the
  // hook settled on.
  await stream.writable.getWriter().write(new Uint8Array(gzipSync(Buffer.alloc(1024 * 1024, 0x61))));
} catch {
  // The cancelled stream's error path decides the write's fate.
}
hook.disable();
console.log("done");
