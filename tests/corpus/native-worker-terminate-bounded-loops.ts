// worker.terminate() stops a worker whose loop runs short inner loops:
// counted loops of a few iterations, a two-counter loop, an inner loop
// whose length grows past 64 iterations, an inner loop too long to finish,
// a nest of loops with constant bounds, and an inner loop whose counter
// stops changing at 2 ** 53 (`j + 1 === j` there), so it never ends.
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

function counted(values: number[]): number {
  let acc = 0;
  for (let round = 0; ; round++) {
    for (let i = 0; i < values.length; i++) acc = (acc + values[i]! * i) % 1000003;
    for (let i = values.length - 1; i >= 0; i -= 2) acc = (acc * 7 + values[i]!) % 1000003;
    if (round === 200) parentPort!.postMessage("ready");
  }
  return acc;
}

function paired(values: number[]): number {
  let flips = 0;
  for (let round = 0; ; round++) {
    for (let i = 0, j = values.length - 1; i < j; i++, j--) {
      const t = values[i]!;
      values[i] = values[j]!;
      values[j] = t;
      flips++;
    }
    if (round === 200) parentPort!.postMessage("ready");
  }
  return flips;
}

function growing(): number {
  let acc = 0;
  for (let n = 1; ; n++) {
    const limit = n % 200;
    for (let i = 0; i < limit; i++) acc = (acc + i) % 1000003;
    if (n === 200) parentPort!.postMessage("ready");
  }
  return acc;
}

function long(limit: number): number {
  let acc = 0;
  for (let round = 0; ; round++) {
    for (let i = 0; i < limit; i++) {
      acc = (acc * 7 + i) % 1000003;
      if (i === 100000) parentPort!.postMessage("ready");
    }
  }
  return acc;
}

const ROUNDS = 50;

function constant(row: Float64Array): number {
  let acc = 0;
  for (let y = 0; ; y++) {
    for (let i = 0; i < 8; i += 2) {
      const c = row[i]!;
      for (let j = 0; j < ROUNDS; j++) {
        acc = (acc * 3 + j + c) % 1000003;
        if (acc === -1) break;
      }
    }
    if (y === 200) parentPort!.postMessage("ready");
  }
  return acc;
}

function stalled(): number {
  let acc = 0;
  for (let round = 0; ; round++) {
    if (round === 0) parentPort!.postMessage("ready");
    for (let j = 9007199254740990; j < 9007199254741002; j++) acc = (acc + (j % 7)) % 1000003;
  }
  return acc;
}

if (isMainThread) {
  for (const kind of ["counted", "paired", "growing", "long", "constant", "stalled"]) {
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
  const values = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8];
  let result = 0;
  if (workerData === "counted") result = counted(values);
  else if (workerData === "paired") result = paired(values);
  else if (workerData === "growing") result = growing();
  else if (workerData === "long") result = long(1e15);
  else if (workerData === "stalled") result = stalled();
  else result = constant(new Float64Array(8).fill(0.25));
  console.log("unexpected result", result);
}
