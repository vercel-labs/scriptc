import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

// Loops over typed-array views of shared memory in a worker program: row
// sums and element-wise passes whose accesses are in bounds, the same loops
// running past a view's end, a loop that mixes a shared view with one the
// thread owns, and views of one SharedArrayBuffer that overlap, written in
// an order that shows whether each read sees the previous write. The worker
// writes its results into shared memory, which the main thread reads after
// the worker reports.

interface Job {
  sab: SharedArrayBuffer;
  n: number;
}

function rowSums(u: Float64Array, v: Float64Array, start: number, end: number, n: number): void {
  for (let i = start; i < end; i++) {
    let t = 0;
    for (let j = 0; j < n; j++) t = t + u[j]! / (((i + j) * (i + j + 1)) / 2 + i + 1);
    v[i] = t;
  }
}

function scaled(src: Float64Array, dst: Float64Array, k: number, count: number): void {
  for (let i = 0; i < count; i++) dst[i] = src[i]! * k + 1;
}

function mixed(shared: Int32Array, owned: Int32Array, count: number): number {
  let sum = 0;
  for (let i = 0; i < count; i++) {
    owned[i] = shared[i]! * 3;
    shared[i] = owned[i]! - i;
    sum = (sum + shared[i]! + owned[i]!) | 0;
  }
  return sum;
}

function shift(a: Float64Array, b: Float64Array, count: number): void {
  for (let i = 0; i < count; i++) a[i + 1] = b[i]! + 1;
}

function checksum(values: Float64Array): string {
  let h = 0;
  for (let i = 0; i < values.length; i++) h = (Math.imul(h, 31) + Math.round(values[i]! * 1e6)) >>> 0;
  return h.toString(16);
}

function work({ sab, n }: Job): string[] {
  const out: string[] = [];
  const u = new Float64Array(sab, 0, n);
  const v = new Float64Array(sab, n * 8, n);
  for (let i = 0; i < n; i++) u[i] = 1 + (i % 5) / 4;
  rowSums(u, v, 0, n, n);
  out.push(`rows ${checksum(v)}`);
  // Past the end of u: the reads beyond it are undefined, so the sums are NaN.
  rowSums(u, v, 0, 4, n + 3);
  out.push(`past ${v[0]} ${v[3]} ${checksum(v.subarray(4))}`);
  scaled(u, v, 0.5, n);
  out.push(`scaled ${checksum(v)}`);
  scaled(u, v, 2, n + 2);
  out.push(`scaled past ${checksum(v)}`);
  const ints = new Int32Array(sab, 2 * n * 8, 32);
  for (let i = 0; i < 32; i++) ints[i] = i * 7 - 50;
  const own = new Int32Array(32);
  out.push(`mixed ${mixed(ints, own, 32)} ${mixed(ints, own, 34)} ${ints[5]} ${own[31]}`);
  // a[i + 1] lands on b[i + 1] when b starts one element after a.
  const a = new Float64Array(sab, 0, 24);
  const b = new Float64Array(sab, 8, 24);
  for (let i = 0; i < 25; i++) u[i] = i;
  shift(a, b, 20);
  out.push(`overlap ${Array.from(a.subarray(0, 8)).join(",")}`);
  shift(b, a, 20);
  out.push(`overlap back ${Array.from(b.subarray(0, 8)).join(",")}`);
  return out;
}

if (isMainThread) {
  const n = 40;
  const sab = new SharedArrayBuffer(2 * n * 8 + 32 * 4);
  const worker = new Worker(new URL(import.meta.url), { workerData: { sab, n } satisfies Job });
  worker.on("message", (lines: string[]) => {
    for (const line of lines) console.log("worker", line);
    const v = new Float64Array(sab, n * 8, n);
    const ints = new Int32Array(sab, 2 * n * 8, 32);
    console.log("main sees", checksum(v), ints[0], ints[31]);
    // The same passes on the main thread, over a fresh buffer.
    const again = new SharedArrayBuffer(2 * n * 8 + 32 * 4);
    for (const line of work({ sab: again, n })) console.log("main", line);
  });
  worker.on("exit", (code: number) => console.log("exit", code));
} else {
  parentPort!.postMessage(work(workerData as Job));
}
