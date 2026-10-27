import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { publish } from "@scriptc/threads";

// Every thread builds and drops young cycles of its own while it publishes
// graphs of freshly built objects and posts them. Publishing takes young
// objects out of the thread's nursery before they become shared, so the
// receiving thread reads them intact while both threads keep collecting.
// Receivers publish() what they receive (a no-op in scriptc) and read only
// data, so Node.js prints the same.

class Node {
  parent: Node | null = null;
  next: Node | null = null;
  children: Node[] = [];
  label: string;
  constructor(label: string) {
    this.label = label;
  }
}

function graph(prefix: string, width: number): Node {
  const root = new Node(`${prefix}root`);
  let last: Node | null = null;
  for (let i = 0; i < width; i++) {
    const child = new Node(`${prefix}${i}`);
    child.parent = root;
    if (last !== null) last.next = child;
    last = child;
    root.children.push(child);
  }
  if (last !== null) last.next = root.children[0]!;
  return root;
}

function churn(rounds: number): number {
  let acc = 0;
  for (let i = 0; i < rounds; i++) {
    const a = new Node(`a${i}`);
    const b = new Node(`b${i}`);
    a.next = b;
    b.next = a;
    acc = (acc + a.next.label.length + b.next.label.length) % 1000003;
  }
  return acc;
}

function describe(root: Node): string {
  let out = root.label;
  for (const c of root.children) out += ` ${c.label}^${c.parent?.label}>${c.next?.label}`;
  return out;
}

if (isMainThread) {
  const replies: string[] = [];
  let pending = 3;
  for (let w = 0; w < 3; w++) {
    const shared = publish(graph(`m${w}.`, 3));
    const worker = new Worker(new URL(import.meta.url), { workerData: { id: w, shared } });
    worker.on("message", (message: unknown) => {
      const received = message as { id: number; graph: Node; churned: number };
      publish(received.graph);
      replies[w] = `worker ${received.id}: ${describe(received.graph)} churn=${received.churned}`;
    });
    worker.on("exit", () => {
      if (--pending === 0) {
        for (const line of replies) console.log(line);
        console.log(`main churn ${churn(20000)}`);
      }
    });
  }
  console.log(`main churn ${churn(20000)}`);
} else {
  const { id, shared } = workerData as { id: number; shared: Node };
  publish(shared);
  const churned = churn(30000);
  const fresh = graph(`w${id}.`, 4);
  fresh.children[1]!.children.push(new Node(`w${id}.leaf`));
  publish(fresh);
  churn(10000);
  parentPort!.postMessage({ id, graph: fresh, churned: (churned + describe(shared).length) % 1000003 });
}
