// worker.terminate() stops a worker that spends its time in short runs of
// inner loops: counted and paired loops of a few iterations inside loops
// without a condition, runs at the length where an inner loop starts to
// poll on its own, and a short inner loop whose body calls a slow function.
// Each terminate resolves promptly.
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

function flips(n: number): number {
  const p = new Int32Array(n),
    q = new Int32Array(n),
    count = new Int32Array(n);
  for (let i = 0; i < n; i++) p[i] = i;
  let total = 0;
  for (let round = 0; ; round++) {
    for (let i = 0; i < n; i++) q[i] = p[i]!;
    let first = q[0]!;
    for (;;) {
      if (first === 0) break;
      for (let i = 0, j = first; i < j; i++, j--) {
        const t = q[i]!;
        q[i] = q[j]!;
        q[j] = t;
      }
      total++;
      first = q[0]!;
    }
    // The next permutation: rotate the first k + 1 elements for the
    // smallest k whose count has not run out.
    for (let k = 1; ; k++) {
      if (k === n) {
        for (let i = 0; i < n; i++) p[i] = i;
        count.fill(0);
        break;
      }
      const head = p[0]!;
      for (let i = 0; i < k; i++) p[i] = p[i + 1]!;
      p[k] = head;
      if (++count[k]! <= k) break;
      count[k] = 0;
    }
    if (round === 2000) parentPort!.postMessage("ready");
  }
  return total;
}

function thresholds(values: number[]): number {
  let acc = 0;
  for (let round = 0; ; round++) {
    for (const run of [63, 64, 65]) {
      for (let i = 0; i < run; i++) acc = (acc + values[i]! * round) % 1000003;
      for (let i = 0, j = run; i < j; i++, j--) acc = (acc + values[i]! + values[j]!) % 1000003;
    }
    if (round === 2000) parentPort!.postMessage("ready");
  }
  return acc;
}

function slow(seed: number): number {
  let acc = seed;
  for (let i = 0; i < 20000; i++) acc = (acc * 31 + i) % 1000003;
  return acc;
}

function slowBodies(): number {
  let acc = 0;
  for (let round = 0; ; round++) {
    for (let i = 0; i < 4; i++) acc = (acc + slow(acc + i)) % 1000003;
    if (round === 50) parentPort!.postMessage("ready");
  }
  return acc;
}

if (isMainThread) {
  for (const kind of ["flips", "thresholds", "slow"]) {
    await new Promise<void>((resolve) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: kind });
      worker.once("message", () => {
        const asked = Date.now();
        void worker.terminate().then((code: number) => {
          console.log(kind, "terminate", code, Date.now() - asked < 1000 ? "prompt" : "late");
        });
      });
      worker.once("exit", (code: number) => {
        console.log(kind, "exit", code);
        resolve();
      });
    });
  }
} else {
  let result = 0;
  if (workerData === "flips") result = flips(9);
  else if (workerData === "thresholds")
    result = thresholds(Array.from({ length: 70 }, (_, i) => i));
  else result = slowBodies();
  console.log("unexpected result", result);
}
