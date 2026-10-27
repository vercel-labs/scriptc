import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

// Typed-array loops in a worker-enabled program, over views of a thread's
// own ArrayBuffer, views of a SharedArrayBuffer, and both in one loop. Each
// loop gives the same results whichever kind of buffer its views use, and
// writes through shared views are visible to the other thread.

function scale(src: Float64Array, dst: Float32Array, k: number): void {
  for (let i = 0; i < dst.length; i++) dst[i] = src[i]! * k;
}

function countAbove(view: Int16Array, limit: number): number {
  let n = 0;
  for (let i = 0; i < view.length; i++) if (view[i]! > limit) n++;
  return n;
}

function mix(a: Uint8Array, b: Uint8Array, out: Uint8ClampedArray): void {
  const n = out.length;
  for (let i = 0; i < n; i++) out[i] = a[i]! * 2 - b[i]!;
}

function bump(view: Int32Array, by: number): void {
  for (let i = 0; i < view.length; i++) view[i] = (view[i]! + by) | 0;
}

function report(label: string, src: Float64Array, dst: Float32Array, ints: Int16Array, a: Uint8Array, b: Uint8Array, out: Uint8ClampedArray): string {
  for (let i = 0; i < src.length; i++) src[i] = i * 1.5 - 4;
  for (let i = 0; i < ints.length; i++) ints[i] = (i * 7919) % 2001 - 1000;
  for (let i = 0; i < a.length; i++) {
    a[i] = i * 37;
    b[i] = 255 - i * 11;
  }
  scale(src, dst, 0.1);
  mix(a, b, out);
  return `${label}: ${dst.join(",")} | ${countAbove(ints, 250)} ${countAbove(ints.subarray(3), -1)} | ${out.join(",")}`;
}

function views(buffer: ArrayBuffer | SharedArrayBuffer, other: ArrayBuffer | SharedArrayBuffer): string {
  const src = new Float64Array(buffer, 0, 12);
  const dst = new Float32Array(other, 0, 10);
  const ints = new Int16Array(buffer, 96, 40);
  const a = new Uint8Array(other, 40, 16);
  const b = new Uint8Array(buffer, 176, 16);
  const out = new Uint8ClampedArray(other, 56, 16);
  return report("pair", src, dst, ints, a, b, out);
}

if (isMainThread) {
  // Bytes 224-255 of the shared buffer hold counters the views never use.
  const shared = new SharedArrayBuffer(256);
  console.log(views(new ArrayBuffer(256), new ArrayBuffer(256)));
  console.log(views(shared, new ArrayBuffer(256)));
  console.log(views(new ArrayBuffer(256), shared));
  console.log(views(shared, new SharedArrayBuffer(256)));
  const own = new Int32Array(8);
  bump(own, 5);
  bump(new Int32Array(shared, 224, 8), 1);
  const worker = new Worker(new URL(import.meta.url), { workerData: shared });
  worker.on("message", (line: string) => console.log(line));
  worker.on("exit", (code: number) => {
    const seen = new Int32Array(shared, 224, 8);
    bump(seen, 1000);
    console.log(`exit ${code}: ${seen.join(",")} own ${own.join(",")}`);
    console.log(`dst after worker: ${new Float32Array(shared, 0, 10).join(",")}`);
  });
} else {
  const shared = workerData as SharedArrayBuffer;
  const counters = new Int32Array(shared, 224, 8);
  bump(counters, 10);
  bump(counters.subarray(2, 5), -3);
  parentPort!.postMessage(`worker: ${counters.join(",")}`);
  parentPort!.postMessage(views(new ArrayBuffer(256), shared));
}
