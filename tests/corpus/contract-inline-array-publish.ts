import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { publish } from "@scriptc/threads";
import type { ProgramLifetime } from "@scriptc/types";
import type { InlineArray } from "@scriptc/experimental";

// InlineArray fields of ProgramLifetime instances published with
// @scriptc/threads. scriptc shares the published graph by reference, with
// the elements in the instances; Node.js clones it for the worker. The
// worker reads fields only (a Node.js clone has no prototype), so both
// runtimes print the same.

class Node implements ProgramLifetime {
  readonly kind: string;
  readonly pos: number;
  readonly children: NodeList;
  constructor(kind: string, pos: number, children: NodeList) {
    this.kind = kind;
    this.pos = pos;
    this.children = children;
  }
}

class NodeList implements ProgramLifetime {
  readonly pos: number;
  readonly nodes: InlineArray<Node>;
  constructor(pos: number, nodes: readonly Node[]) {
    this.pos = pos;
    this.nodes = nodes;
  }
}

class Modifiers extends NodeList {
  readonly flags: number;
  constructor(pos: number, nodes: readonly Node[], flags: number) {
    super(pos, nodes);
    this.flags = flags;
  }
}

const none = new NodeList(-1, []);

function tree(level: number, pos: number): Node {
  const kids: Node[] = [];
  if (level > 0) for (let i = 0; i < level + 1; i++) kids.push(tree(level - 1, pos * 4 + i));
  const list = level % 2 === 0 ? new Modifiers(pos, kids, level) : new NodeList(pos, kids);
  return new Node(level === 0 ? "leaf" : "group", pos, kids.length === 0 ? none : list);
}

function summary(node: Node): string {
  const nodes = node.children.nodes;
  if (nodes.length === 0) return `${node.kind}@${node.pos}`;
  const parts: string[] = [];
  for (let i = 0; i < nodes.length; i++) parts.push(summary(nodes[i]!));
  return `${node.kind}@${node.pos}[${parts.join(" ")}]`;
}

function count(node: Node): number {
  let n = 1;
  for (const child of node.children.nodes) n += count(child);
  return n;
}

if (isMainThread) {
  const root = publish(tree(4, 1));
  console.log("main", count(root), summary(root).length, summary(root).slice(0, 80));
  const worker = new Worker(new URL(import.meta.url), { workerData: root });
  worker.on("message", (line: string) => console.log(line));
  worker.on("exit", (code) => console.log("worker exit", code));
} else {
  const root = workerData as Node;
  const first = root.children.nodes[0]!;
  parentPort!.postMessage(
    `worker ${count(root)} ${summary(root).length} ${first.children.nodes.length} ${summary(first).slice(0, 60)}`,
  );
}
