// Arena groups in worker threads: each worker builds and reads trees of
// classes and record literals, groups that live in the worker's own arena
// until the statement or loop body that holds them ends. The main thread
// builds its own groups meanwhile and keeps one tree for the whole run.
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

class Pair {
  left: Pair | null;
  right: Pair | null;
  label: string;
  constructor(left: Pair | null, right: Pair | null, label: string) {
    this.left = left;
    this.right = right;
    this.label = label;
  }
}

interface Leaf {
  left: Leaf | null;
  right: Leaf | null;
  weight: number;
}

function pairs(depth: number, label: string): Pair {
  return depth === 0 ? new Pair(null, null, label) : new Pair(pairs(depth - 1, label + "l"), pairs(depth - 1, label + "r"), label);
}

function leaves(depth: number, weight: number): Leaf {
  return depth === 0
    ? { left: null, right: null, weight }
    : { left: leaves(depth - 1, weight + 1), right: leaves(depth - 1, weight * 2), weight };
}

function countPairs(p: Pair): number {
  return 1 + (p.left === null ? 0 : countPairs(p.left)) + (p.right === null ? 0 : countPairs(p.right));
}

function rightmost(p: Pair): string {
  return p.right === null ? p.label : rightmost(p.right);
}

function weigh(l: Leaf): number {
  return l.weight + (l.left === null ? 0 : weigh(l.left)) + (l.right === null ? 0 : weigh(l.right));
}

function task(depth: number, rounds: number): string {
  let nodes = 0;
  let total = 0;
  for (let i = 0; i < rounds; i++) {
    nodes += countPairs(pairs(depth, "p"));
    total += weigh(leaves(depth, i));
  }
  const kept = pairs(depth, "k");
  return `depth ${depth}: ${nodes} pairs, weight ${total}, rightmost ${rightmost(kept)}, kept ${countPairs(kept)}`;
}

if (isMainThread) {
  const longLived = leaves(10, 1);
  const depths = [3, 5, 7, 9];
  const lines: string[] = new Array(depths.length).fill("");
  let pending = depths.length;
  depths.forEach((depth, index) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: depth });
    worker.on("message", (line: string) => {
      lines[index] = line;
      if (--pending === 0) {
        for (const l of lines) console.log(l);
        console.log("main", task(6, 20));
        console.log("long lived", weigh(longLived));
      }
    });
  });
} else {
  parentPort!.postMessage(task(workerData as number, 50));
}
