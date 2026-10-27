import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import type { ProgramLifetime } from "@scriptc/types";

// Waves of workers that each build a graph of ProgramLifetime instances
// referring to each other, post a checksum of it and exit without sharing
// anything. scriptc never frees such instances while the worker runs; on
// Linux their memory goes back after the worker exits, like the rest of
// its memory, and later workers reuse it.

class Item implements ProgramLifetime {
  readonly id: number;
  next: Item | undefined = undefined;
  owner: Group | undefined = undefined;
  constructor(id: number) {
    this.id = id;
  }
}

class Group implements ProgramLifetime {
  readonly name: string;
  first: Item | undefined = undefined;
  previous: Group | undefined = undefined;
  count = 0;
  constructor(name: string) {
    this.name = name;
  }
  add(item: Item): void {
    item.owner = this;
    item.next = this.first;
    this.first = item;
    this.count++;
  }
}

function build(seed: number, groups: number, items: number): number {
  let last: Group | undefined = undefined;
  for (let g = 0; g < groups; g++) {
    const group: Group = new Group(`g${seed}.${g}`);
    group.previous = last;
    for (let i = 0; i < items; i++) group.add(new Item(seed * 1000003 + g * items + i));
    last = group;
  }
  let sum = 0;
  for (let group = last; group !== undefined; group = group.previous) {
    for (let item = group.first; item !== undefined; item = item.next) {
      if (item.owner === group) sum = (sum + item.id * (group.count % 97)) % 1000000007;
    }
  }
  return sum;
}

function runWorker(seed: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: seed });
    let sum = -1;
    worker.on("message", (value: number) => {
      sum = value;
    });
    worker.on("error", reject);
    worker.on("exit", () => resolve(sum));
  });
}

async function main(): Promise<void> {
  for (let wave = 0; wave < 3; wave++) {
    const first = runWorker(wave * 2);
    const second = runWorker(wave * 2 + 1);
    console.log(`wave ${wave}: ${await first} ${await second}`);
  }
  // The workers' memory goes back shortly after the last one exits.
  await new Promise((resolve) => setTimeout(resolve, 300));
  console.log("main", build(99, 4, 1000));
}

if (isMainThread) {
  void main();
} else {
  parentPort!.postMessage(build(workerData as number, 50, 4000));
}
