import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { publish } from "@scriptc/threads";
import type { ProgramLifetime } from "@scriptc/types";

// Workers whose memory goes back when they exit, and workers whose memory
// stays because other threads hold what they allocated. Builder workers
// create ProgramLifetime instances (which scriptc never frees), ordinary
// objects, strings and large typed arrays, post a checksum and exit. A
// publisher worker posts published graphs (a class graph and a plain
// object) and exits. The main thread reads those graphs again after each
// wave of builders, which in scriptc on Linux reuse the memory of the
// builders before them.

class Node implements ProgramLifetime {
  readonly kind: number;
  readonly label: string;
  readonly children: Node[] = [];
  parent: Node | undefined = undefined;
  constructor(kind: number, label: string) {
    this.kind = kind;
    this.label = label;
  }
}

type Summary = { readonly name: string; readonly values: readonly number[]; readonly nested: { readonly total: number } };

type Job = { readonly role: string; readonly seed: number };

function build(seed: number, count: number): Node {
  const root = new Node(seed, "root" + seed);
  let parent = root;
  for (let i = 0; i < count; i++) {
    const node = new Node((i * 7 + seed) % 31, "n" + (i % 101));
    node.parent = parent;
    parent.children.push(node);
    if (i % 64 === 63) parent = node;
  }
  return root;
}

function checksum(root: Node): number {
  let sum = 0;
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    sum = (sum * 31 + node.kind + node.label.length + node.children.length) % 1_000_003;
    for (const child of node.children) stack.push(child);
  }
  return sum;
}

function startWorker(job: Job, onMessage: (value: unknown) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: job });
    worker.on("message", onMessage);
    worker.once("messageerror", reject);
    worker.once("error", reject);
    worker.once("exit", () => resolve());
  });
}

if (isMainThread) {
  let tree: Node | undefined = undefined;
  let summary: Summary | undefined = undefined;
  // The publisher posts the tree, then the summary.
  await startWorker({ role: "publisher", seed: 3 }, (value) => {
    if (tree === undefined) tree = value as Node;
    else summary = value as Summary;
  });
  const describe = (): string =>
    `tree ${checksum(tree!)} summary ${summary!.name} ${summary!.values.join(",")} ${summary!.nested.total}`;
  console.log("published", describe());
  for (let wave = 0; wave < 3; wave++) {
    const sums: number[] = [];
    await Promise.all(
      [1, 2, 3, 4].map((k) => startWorker({ role: "builder", seed: wave * 10 + k }, (value) => sums.push(value as number))),
    );
    sums.sort((a, b) => a - b);
    console.log("wave", wave, sums.join(" "), describe());
  }
} else {
  const job = workerData as Job;
  if (job.role === "publisher") {
    parentPort!.postMessage(publish(build(job.seed, 20_000)));
    const values: number[] = [];
    for (let i = 0; i < 50; i++) values.push(i * job.seed);
    parentPort!.postMessage(publish({ name: "summary" + job.seed, values, nested: { total: values.length } }));
  } else {
    const root = build(job.seed, 150_000);
    const samples: Float64Array[] = [];
    for (let i = 0; i < 40; i++) {
      const sample = new Float64Array(8192);
      for (let j = 0; j < sample.length; j += 97) sample[j] = i + j + job.seed;
      samples.push(sample);
    }
    let extra = 0;
    for (const sample of samples) extra = (extra + sample[97]! + sample[8148]!) % 1_000_003;
    const words: string[] = [];
    for (let i = 0; i < 20_000; i++) words.push(`word-${i % 977}-${job.seed}`);
    parentPort!.postMessage((checksum(root) + extra + words.join("").length) % 1_000_003);
  }
}
