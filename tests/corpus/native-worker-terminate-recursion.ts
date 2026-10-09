import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

class Node2 {
  left: Node2 | null;
  right: Node2 | null;
  constructor(depth: number) {
    this.left = depth > 0 ? new Node2(depth - 1) : null;
    this.right = depth > 0 ? new Node2(depth - 1) : null;
  }
  count(): number {
    return 1 + (this.left ? this.left.count() : 0) + (this.right ? this.right.count() : 0);
  }
}

function weight(n: number): number {
  return n * 2 + 1;
}

function spin(n: number): number {
  return n < 2 ? weight(n) : spin(n - 1) + spin(n - 2);
}

function even(n: number): boolean {
  return n === 0 ? true : odd(n - 1);
}
function odd(n: number): boolean {
  return n === 0 ? false : even(n - 1);
}

function forever(kind: string): number {
  if (kind === "recursion") return spin(60);
  if (kind === "mutual") return even(4000) ? forever(kind) : 0;
  if (kind === "methods") return new Node2(12).count() + forever(kind);
  const step = (n: number): number => (n > 0 ? step(n - 1) : forever(kind));
  return step(100);
}

if (isMainThread) {
  for (const kind of ["recursion", "mutual", "methods", "closures"]) {
    await new Promise<void>((resolve) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: kind });
      worker.once("message", () => {
        void worker.terminate();
      });
      worker.once("exit", (code: number) => {
        console.log(kind, "exit", code);
        resolve();
      });
    });
  }
  console.log("main", spin(10), even(10), new Node2(3).count());
} else {
  parentPort!.postMessage("ready");
  try {
    console.log("unexpected result", forever(String(workerData)));
  } catch {
    console.log("unexpected catch");
  } finally {
    console.log("unexpected finally");
  }
}
