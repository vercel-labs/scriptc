import { Worker, isMainThread, parentPort } from "node:worker_threads";

// Each script thread has its own dispose hook: a worker that keeps checked
// record sources and weak keys serializes and forgets them on its own,
// while the main thread runs the same code without sharing its state.
interface Row {
  id: number;
  name: string;
}
class Key {
  id: number;
  constructor(id: number) {
    this.id = id;
  }
}

function run(who: string, base: number): string[] {
  const out: string[] = [];
  const text = `[{"id":${base},"extra":"${who}","name":"a"},{"name":"b","id":${base + 1}}]`;
  const rows = JSON.parse(text) as Row[];
  out.push(JSON.stringify(rows));
  rows.length = 0;
  const fresh: Row[] = [];
  for (let i = 0; i < 32; i++) fresh.push({ id: base + i, name: who });
  out.push(String(JSON.stringify(fresh).includes("extra")));
  const seen = new WeakSet<Key>();
  for (let i = 0; i < 32; i++) seen.add(new Key(i));
  let stale = 0;
  for (let i = 0; i < 32; i++) if (seen.has(new Key(i))) stale++;
  out.push(`${who} stale ${stale}`);
  return out;
}

if (isMainThread) {
  for (const line of run("main", 0)) console.log(line);
  const worker = new Worker(new URL(import.meta.url));
  worker.on("message", (lines: string[]) => {
    for (const line of lines) console.log(line);
  });
  worker.on("exit", (code) => console.log("worker exit", code));
} else {
  parentPort!.postMessage(run("worker", 100));
}
