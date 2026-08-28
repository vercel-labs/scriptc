// @exit: 1
// Fatal callback exits must release completed and queued native rename work.
import { existsSync, mkdtempSync, rename, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "scr-rename-abort-"));
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
const sources: string[] = [];

for (let i = 0; i < 8; i++) {
  const source = join(dir, `source-${i}`);
  const destination = join(dir, `destination-${i}`);
  sources.push(source);
  writeFileSync(source, "x");
  rename(source, destination, () => {
    // Keep the main thread in the first callback until the remaining workers
    // have completed. Their callbacks stay undispatched when this one throws,
    // so the runtime's fatal-exit cleanup must release all retained payloads.
    for (;;) {
      let pending = false;
      for (const path of sources) {
        if (existsSync(path)) pending = true;
      }
      if (!pending) break;
      Atomics.wait(waitBuffer, 0, 0, 10);
    }
    Atomics.wait(waitBuffer, 0, 0, 20);
    rmSync(dir, { recursive: true, force: true });
    throw new Error("rename callback abort");
  });
}
