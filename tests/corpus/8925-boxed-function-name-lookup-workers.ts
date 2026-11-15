import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

// Function values boxed without a static name, in a worker thread and on
// the main thread: each thread looks the names up for itself, and both
// answer the same names.
function alpha(): number {
  return 1;
}
function beta(): number {
  return 2;
}
function gamma(): number {
  return 3;
}
function delta(): number {
  return 4;
}
function epsilon(): number {
  return 5;
}
const named: (() => number)[] = [alpha, beta, gamma, delta, epsilon];

function nameOf(value: unknown): string {
  return typeof value === "function" ? JSON.stringify(value.name) : "not a function";
}

function work(seed: number): string {
  const parts: string[] = [];
  for (let i = 0; i < 400; i++) {
    const holder: unknown = { f: named[(i + seed) % named.length]!, g: () => i };
    const { f, g } = holder as { f: unknown; g: unknown };
    if (i < 6) parts.push(`${nameOf(f)}${nameOf(g)}`);
    else if (nameOf(f) !== JSON.stringify(named[(i + seed) % named.length]!.name)) parts.push("mismatch");
  }
  return `${seed}: ${parts.join(" ")}`;
}

if (isMainThread) {
  const fromWorker = await new Promise<string>((resolve, reject) => {
    let result = "";
    const worker = new Worker(new URL(import.meta.url), { workerData: 1 });
    worker.once("message", (value: unknown) => {
      result = value as string;
    });
    worker.once("error", reject);
    worker.once("exit", () => resolve(result));
  });
  console.log(work(0));
  console.log(fromWorker);
} else {
  parentPort!.postMessage(work(workerData as number));
}
