// Pure integer recursion over record graphs on worker threads: tree
// counts, sums that leave the int32 range, and a stack overflow the worker
// catches.
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

interface Tree {
  left: Tree | null;
  right: Tree | null;
}

interface Item {
  weight: number;
  next: Item | null;
}

interface Task {
  depth: number;
  weight: number;
}

interface Report {
  text: string;
}

function build(depth: number): Tree {
  return depth > 0 ? { left: build(depth - 1), right: build(depth - 1) } : { left: null, right: null };
}

function count(node: Tree): number {
  if (node.left === null || node.right === null) return 1;
  return 1 + count(node.left) + count(node.right);
}

function total(item: Item): number {
  return item.next === null ? item.weight : item.weight + total(item.next);
}

function run({ depth, weight }: Task): string {
  let check = 0;
  for (let i = 0; i < 4; i++) check += count(build(depth));
  let head: Item | null = null;
  for (let i = 0; i < 8; i++) head = { weight, next: head };
  const ring: Item = { weight: 1, next: null };
  ring.next = { weight: 2, next: ring };
  let overflow = "";
  try {
    overflow = String(total(ring));
  } catch (e) {
    overflow = `${e instanceof RangeError} ${(e as Error).message}`;
  }
  return `depth ${depth}: check ${check}, total ${total(head!)}, ring ${overflow}`;
}

if (isMainThread) {
  const tasks: Task[] = [
    { depth: 4, weight: 3 },
    { depth: 12, weight: 1e9 },
    { depth: 8, weight: 0.5 },
  ];
  const results = await Promise.all(
    tasks.map(
      (task) =>
        new Promise<string>((resolve) => {
          const worker = new Worker(new URL(import.meta.url), { workerData: task });
          worker.on("message", (report: Report) => resolve(report.text));
        }),
    ),
  );
  for (const line of results) console.log(line);
  console.log("main", run({ depth: 10, weight: -2147483648 }));
} else {
  const report: Report = { text: run(workerData as Task) };
  parentPort!.postMessage(report);
}
