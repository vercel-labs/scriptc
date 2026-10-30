import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

// Typed-array loops in a worker program that run to a count passed in, not
// to a view's length, over views of a SharedArrayBuffer, of a thread's own
// buffer, and both in one loop. Counts within the views, past their ends
// (reads give undefined, writes are dropped) and over subarrays at an
// offset. A worker's writes through shared views are visible to the parent.

interface Job {
  shared: SharedArrayBuffer;
  n: number;
}

function rowSums(u: Float64Array, v: Float64Array, n: number, rows: number): void {
  for (let i = 0; i < rows; i++) {
    let t = 0;
    for (let j = 0; j < n; j++) t += u[j]! / (i + j + 1);
    v[i] = t;
  }
}

function copyScaled(src: Int32Array, dst: Int32Array, n: number, k: number): number {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    dst[i] = (src[i]! * k) | 0;
    sum += dst[i]!;
  }
  return sum;
}

function sumTo(view: Float64Array, n: number): number {
  let total = 0;
  for (let i = 0; i < n; i++) total += view[i]!;
  return total;
}

function fixed(view: Float64Array, count: number): string {
  const parts: string[] = [];
  for (let i = 0; i < count; i++) parts.push(view[i]!.toFixed(6));
  return parts.join(" ");
}

function run(label: string, u: Float64Array, v: Float64Array, ints: Int32Array, out: Int32Array, n: number): string {
  rowSums(u, v, n, 4);
  const scaled = copyScaled(ints, out, n, 3);
  return `${label}: rows ${fixed(v, 4)}; scaled ${scaled}; tail ${sumTo(u, n + 3)}`;
}

function views(buffer: ArrayBufferLike, n: number): { u: Float64Array; v: Float64Array; ints: Int32Array; out: Int32Array } {
  const u = new Float64Array(buffer, 0, n);
  const v = new Float64Array(buffer, 8 * n, n);
  const ints = new Int32Array(buffer, 16 * n, n);
  const out = new Int32Array(buffer, 20 * n, n);
  for (let i = 0; i < n; i++) {
    u[i] = 1 + i * 0.25;
    ints[i] = i * 7 - 20;
  }
  return { u, v, ints, out };
}

if (isMainThread) {
  const n = 12;
  const shared = new SharedArrayBuffer(24 * n);
  const own = views(new ArrayBuffer(24 * n), n);
  console.log(run("own", own.u, own.v, own.ints, own.out, n));
  const sh = views(shared, n);
  console.log(run("shared", sh.u, sh.v, sh.ints, sh.out, n));
  console.log(run("shared, count past the end", sh.u, sh.v, sh.ints, sh.out, n + 5));
  const mixed = new Float64Array(n);
  rowSums(sh.u, mixed, n, 4);
  console.log("mixed", fixed(mixed, 4));
  console.log("subarray", sumTo(sh.u.subarray(3), n - 3), sumTo(sh.u.subarray(3), n));
  const worker = new Worker(new URL(import.meta.url), { workerData: { shared, n } satisfies Job });
  worker.on("message", (line: string) => {
    console.log(line);
    console.log("parent sees", sh.out.subarray(0, 5).join(","), sh.v[0]!.toFixed(6));
  });
} else {
  const { shared, n } = workerData as Job;
  const u = new Float64Array(shared, 0, n);
  const v = new Float64Array(shared, 8 * n, n);
  const ints = new Int32Array(shared, 16 * n, n);
  const out = new Int32Array(shared, 20 * n, n);
  for (let i = 0; i < n; i++) ints[i] = i * 5 + 1;
  parentPort!.postMessage(run("worker", u, v, ints, out, n));
}
