// Loops to a typed array's length in a program that starts workers, where
// the body assigns the loop's array: the condition reads the new array's
// length on the next iteration, shorter or longer.
import { Worker, isMainThread, parentPort } from "node:worker_threads";

function shrink(values: Float64Array): string {
  let total = 0;
  let steps = 0;
  for (let i = 0; i < values.length; i++) {
    total += values[i]!;
    steps++;
    if (i === 100) values = values.subarray(0, 50);
  }
  return `shrink ${steps} ${total}`;
}

function grow(values: Uint8Array, longer: Uint8Array): string {
  let total = 0;
  let steps = 0;
  for (let i = 0; i < values.length; i++) {
    total += values[i]!;
    steps++;
    if (i === 10) values = longer;
  }
  return `grow ${steps} ${total}`;
}

function swap(a: Int32Array, b: Int32Array): string {
  let total = 0;
  let steps = 0;
  for (let i = 0; i < a.length; i++) {
    total += a[i]!;
    steps++;
    if (i % 70 === 69) {
      const t = a;
      a = b;
      b = t;
    }
  }
  return `swap ${steps} ${total}`;
}

function run(): string[] {
  const values = new Float64Array(300).map((_, i) => i * 0.5);
  const short = new Uint8Array(20).fill(3);
  const long = new Uint8Array(200).map((_, i) => i & 7);
  const a = new Int32Array(100).map((_, i) => i);
  const b = new Int32Array(160).map((_, i) => -i);
  return [shrink(values), grow(short, long), swap(a, b)];
}

if (isMainThread) {
  for (const line of run()) console.log(line);
  const worker = new Worker(new URL(import.meta.url));
  worker.on("message", (lines: string[]) => {
    for (const line of lines) console.log("worker", line);
  });
} else parentPort!.postMessage(run());
