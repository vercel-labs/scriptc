import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

class Counter {
  total = 0;
  add(value: number): void {
    this.total = (this.total + value) % 1000003;
  }
}

function mix(acc: number, value: number): number {
  return (acc * 31 + value) % 1000003;
}

function quit(code: number): void {
  process.exit(code);
}

function settle(code: number): number {
  quit(code);
  console.log("unexpected after exit");
  return code;
}

function churn(kind: string): number {
  let acc = 1;
  const counter = new Counter();
  for (let i = 0; ; i++) {
    if (kind === "calls") acc = mix(acc, i);
    else counter.add(i);
    if (i === 1000) parentPort!.postMessage("ready");
  }
}

if (isMainThread) {
  for (const kind of ["calls", "methods", "exit"]) {
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
  console.log("main", mix(5, 7));
} else if (workerData === "exit") {
  try {
    console.log("settled", settle(3));
  } finally {
    console.log("unexpected finally");
  }
} else {
  try {
    console.log("unexpected", churn(String(workerData)));
  } catch {
    console.log("unexpected catch");
  } finally {
    console.log("unexpected finally");
  }
}
