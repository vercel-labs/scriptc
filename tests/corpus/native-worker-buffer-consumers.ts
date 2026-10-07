import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (isMainThread) {
  const storage = new SharedArrayBuffer(64);
  const bytes = Buffer.from(storage);
  const values = new Uint8Array(storage);
  bytes.fill(65);
  const directory = mkdtempSync(join(tmpdir(), "worker-bytes-"));
  const file = join(directory, "bytes");
  const worker = new Worker(new URL(import.meta.url), {workerData: storage});
  worker.once("message", () => {
    let valid = true;
    for (let i = 0; i < 100; i++) {
      const text = bytes.toString("ascii");
      valid = valid && text.length === 64 && /^[AB]+$/.test(text);
      valid = valid && createHash("sha256").update(bytes).digest("hex").length === 64;
      writeFileSync(file, bytes);
      valid = valid && readFileSync(file).length === 64;
      const sorted = values.toSorted((a: number, b: number) => {
        Atomics.load(values, 0);
        return a - b;
      });
      valid = valid && sorted.length === 64;
    }
    console.log("shared consumers", valid, bytes.buffer === storage);
    rmSync(directory, {recursive: true});
  });
  worker.once("exit", (code: number) => console.log("exit", code));
} else {
  const values = new Uint8Array(workerData as SharedArrayBuffer);
  parentPort!.postMessage("ready");
  for (let i = 0; i < 200000; i++) Atomics.store(values, i % 64, 65 + (i % 2));
}
