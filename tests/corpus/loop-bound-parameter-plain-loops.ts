import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

// Functions whose count parameters bound array loops: nested, counted,
// two-counter and dense array loops, called from the main thread and a
// worker with counts no caller proves to be int32s: integers, fractions,
// NaN, -0, negatives and runs longer than a worker loop's unpolled run.
// Counts past an array's end read undefined.

const LENGTH = 40000;

function rowSums(u: number[], v: number[], n: number, rows: number): void {
  for (let i = 0; i < rows; i++) {
    let t = 0;
    for (let j = 0; j < n; j++) t += u[j]! / (i + j + 1);
    v[i] = t;
  }
}

function scale(src: number[], dst: number[], n: number, k: number): number {
  let sum = 0;
  for (let i = 0; i < n && i < dst.length; i++) {
    dst[i] = (src[i]! * k) | 0;
    sum += dst[i]!;
  }
  return sum;
}

function reverseRange(values: number[], n: number): number {
  for (let lo = 0, hi = (n | 0) - 1; lo < hi; lo++, hi--) {
    const t = values[lo]!;
    values[lo] = values[hi]!;
    values[hi] = t;
  }
  let check = 0;
  for (let i = 0; i < 40; i++) check = (check * 31 + values[i]!) % 1000003;
  return check;
}

function countSevens(values: number[], n: number, step: number): number {
  let seen = 0;
  for (let i = 0; i < n; i += step) if (values[i] === 7) seen++;
  return seen;
}

function show(value: number): string {
  return Object.is(value, -0) ? "-0" : Number.isInteger(value) ? String(value) : value.toFixed(6);
}

function run(label: string, n: number): string {
  const u: number[] = [];
  const ints: number[] = [];
  for (let i = 0; i < LENGTH; i++) {
    u.push(1 + (i % 13) * 0.25);
    ints.push((i % 101) * 7 - 300);
  }
  const v = [0, 0, 0, 0];
  const out = new Array<number>(LENGTH).fill(0);
  rowSums(u, v, n, 4);
  const scaled = scale(ints, out, n, 3);
  const reversed = reverseRange(ints.map((x) => x % 10), n);
  const sevens = countSevens(ints.map((x) => (x + 300) % 11), n, 3);
  return `${label} ${show(n)}: rows ${v.map(show).join(" ")}; scaled ${scaled}; reversed ${reversed}; sevens ${sevens}`;
}

const counts: number[] = JSON.parse("[12, 12.5, 0, -0, -3, 7.25, 16385, 39999.5, 40000.5, 50000]");
counts.push(NaN, Number("9"));

if (isMainThread) {
  for (const n of counts) console.log(run("main", n));
  const worker = new Worker(new URL(import.meta.url), { workerData: counts });
  worker.on("message", (line: string) => console.log(line));
} else {
  for (const n of workerData as number[]) parentPort!.postMessage(run("worker", n));
}
