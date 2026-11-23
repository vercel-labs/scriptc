import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { publish } from "@scriptc/threads";

// A published graph keeps its members reachable from untyped code after a
// worker receives it: presence tests and member reads answer on the
// receiver's own capsule, after the sender released what it made. Covers a
// class instance, a record, a nested array and a published reply.

class Node {
  name: string;
  kids: Node[];
  constructor(name: string) {
    this.name = name;
    this.kids = [];
  }
}

type Row = { id: number; label: string };

function describe(value: any, label: string): void {
  const present: string[] = [];
  for (const key of ["name", "kids", "id", "label", "missing"]) {
    present.push(key + "=" + (key in value));
  }
  console.log(label, present.join(" "), "type", typeof value);
}

if (isMainThread) {
  const root = new Node("root");
  root.kids.push(new Node("kid"));
  publish(root);
  const row: Row = { id: 7, label: "seven" };
  publish(row);
  const worker = new Worker(new URL(import.meta.url), { workerData: { root, row } });
  let reply: any = null;
  worker.on("message", (message: any) => {
    reply = message;
  });
  worker.on("exit", (code: number) => {
    console.log("main received", reply.seen, "seen" in reply);
    console.log("exit", code);
  });
  worker.postMessage({ root, row });
} else {
  const data: any = workerData;
  describe(data.root, "worker sees node");
  describe(data.row, "worker sees row");
  parentPort!.on("message", (message: any) => {
    describe(message.root, "worker sees posted node");
    describe(message.row, "worker sees posted row");
    console.log("worker reads", message.root.name, message.root.kids.length, message.row.id);
    const reply = publish({ seen: message.root.kids.length + message.row.id });
    parentPort!.postMessage(reply);
    parentPort!.close();
  });
}
