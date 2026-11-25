import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

// Each thread has its own instances and its own prototypes: a method
// replaced in a worker, on an instance or on the prototype, is replaced
// there only, and the main thread's calls keep the declared method until
// the main thread replaces it itself.
class Tally {
  private total = 0;
  add(n: number): number {
    this.total += n;
    return this.total;
  }
  read(): number {
    return this.total;
  }
}

function put(target: any, key: string, value: unknown): void {
  target[key] = value;
}

function work(mode: number): string {
  const first = new Tally();
  const second = new Tally();
  let sum = 0;
  for (let i = 0; i < 1000; i++) sum += first.add(1) + second.add(1);
  const before = `${sum}`;
  if (mode === 1) put(first, "add", (n: number) => n * 2);
  if (mode === 2) put(Object.getPrototypeOf(first), "add", (n: number) => n * 3);
  return `${mode}: ${before} ${first.add(5)} ${second.add(5)} ${new Tally().add(5)} ${first.read()}`;
}

if (isMainThread) {
  console.log(work(0));
  for (const mode of [1, 2, 0]) {
    const line = await new Promise<string>((resolve, reject) => {
      let result = "";
      const worker = new Worker(new URL(import.meta.url), { workerData: mode });
      worker.once("message", (value: unknown) => {
        result = value as string;
      });
      worker.once("error", reject);
      worker.once("exit", () => resolve(result));
    });
    console.log(line);
    console.log(work(0));
  }
  console.log(work(2));
  console.log(work(0));
} else {
  parentPort!.postMessage(work(workerData as number));
}
