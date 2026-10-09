import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

class Pool {
  worker: Worker;
  spare: Worker | null = null;
  static last: Worker | undefined = undefined;
  readonly label: string;
  constructor(label: string) {
    this.label = label;
    this.worker = new Worker(new URL(import.meta.url), { workerData: label });
    Pool.last = this.worker;
  }
  owns(other: Worker): boolean {
    return this.worker === other;
  }
  run(): Promise<number> {
    return new Promise((resolve) => {
      this.worker.on("message", (text: string) => {
        console.log(this.label, "says", text);
        void this.worker.terminate();
      });
      this.worker.on("exit", (code: number) => resolve(code));
    });
  }
}

class Shelf {
  slots: (Worker | null)[] = [];
}

if (isMainThread) {
  const first = new Pool("first");
  const held = first.worker;
  console.log("identity", first.owns(held), first.worker === held, Pool.last === held);
  const shelf = new Shelf();
  shelf.slots.push(first.worker, null);
  console.log("first exit", await first.run(), shelf.slots[0] === held);
  const second = new Pool("second");
  console.log("distinct", first.worker !== second.worker, Pool.last === second.worker);
  first.spare = second.worker;
  console.log("spare", first.spare === second.worker, first.owns(second.worker));
  console.log("second exit", await second.run());
  first.spare = null;
  shelf.slots.length = 0;
  Pool.last = undefined;
  console.log("released", first.spare === null, shelf.slots.length, Pool.last === undefined);
} else {
  // Stay alive on the port so terminate() always stops a running worker.
  parentPort!.on("message", () => {});
  parentPort!.postMessage(`hello from ${String(workerData)}`);
}
