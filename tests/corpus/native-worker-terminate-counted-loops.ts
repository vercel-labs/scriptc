// worker.terminate() stops a worker in counted loops over a typed array
// with long bounds: ascending and descending counters, a step above one, a
// second counter that steps with the first, and loops to a typed array's
// length run again and again.
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

function ascending(values: Float64Array, limit: number): number {
  let acc = 0;
  for (let i = 0; i < limit; i++) {
    acc = (acc + values[i & 1023]!) % 1000003;
    if (i === 5000) parentPort!.postMessage("ready");
  }
  return acc;
}

function descending(values: Float64Array, limit: number): number {
  let acc = 0;
  for (let i = limit; i > 0; i -= 3) {
    acc = (acc * 31 + i + values[i & 1023]!) % 1000003;
    if (i === limit - 15000) parentPort!.postMessage("ready");
  }
  return acc;
}

function paired(values: Float64Array, limit: number): number {
  let acc = 0;
  for (let i = 0, j = 7; i < limit; i++, j += 2) {
    acc = (acc + i * j + values[j & 1023]!) % 1000003;
    if (i === 5000) parentPort!.postMessage("ready");
  }
  return acc;
}

function lengths(bytes: Uint8Array): number {
  let acc = 0;
  for (let round = 0; ; round++) {
    for (let i = 0; i < bytes.length; ++i) bytes[i] = bytes[i] === 97 ? 0 : (bytes[i]! + round) & 127;
    for (let i = 0; i < bytes.length; i++) acc = (acc + bytes[i]!) % 1000003;
    if (round === 50) parentPort!.postMessage("ready");
  }
  return acc;
}

if (isMainThread) {
  for (const kind of ["ascending", "descending", "paired", "lengths"]) {
    await new Promise<void>((resolve) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: kind });
      worker.once("message", () => {
        void worker.terminate().then((code: number) => console.log(kind, "terminate", code));
      });
      worker.once("exit", (code: number) => {
        console.log(kind, "exit", code);
        resolve();
      });
    });
  }
} else {
  const values = new Float64Array(1024).map((_, i) => i);
  const limit = 1e15;
  let result = 0;
  if (workerData === "ascending") result = ascending(values, limit);
  else if (workerData === "descending") result = descending(values, limit);
  else if (workerData === "paired") result = paired(values, limit);
  else result = lengths(new Uint8Array(1 << 16).fill(97));
  console.log("unexpected result", result);
}
