// process.stdout.write and process.stderr.write of views into a SharedArrayBuffer that a worker
// filled: a view larger than one write chunk (64 KiB), at a byte offset, one shorter than a chunk,
// and an empty one.
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

type Fill = { buffer: SharedArrayBuffer };

if (isMainThread) {
  const sab = new SharedArrayBuffer(200_000);
  const worker = new Worker(new URL(import.meta.url), { workerData: { buffer: sab } });
  worker.on("message", () => {
    process.stdout.write(new Uint8Array(sab, 1000, 150_000));
    process.stdout.write("\n");
    process.stdout.write(new Uint8Array(sab, 0, 0));

    process.stdout.write(new Uint8Array(sab, 160_000, 20_000));
    process.stdout.write("\n");

    process.stderr.write(new Uint8Array(sab, 63, 70_000));
    process.stderr.write("\n");

    // A replaced write receives the whole view in one call, even when it
    // returns false.
    const out = process.stdout as unknown as Record<string, unknown>;
    const original = out["write"];
    const sizes: number[] = [];
    out["write"] = (chunk: unknown): boolean => {
      sizes.push(typeof chunk === "string" ? chunk.length : (chunk as Uint8Array).length);
      return false;
    };
    const accepted = process.stdout.write(new Uint8Array(sab, 1000, 150_000));
    out["write"] = original;
    console.log("replaced", accepted, sizes.join(","));
    console.log("done");
  });
} else {
  const bytes = new Uint8Array((workerData as Fill).buffer);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 64 === 63 ? 10 : 65 + (i % 26);
  parentPort!.postMessage("filled");
}
