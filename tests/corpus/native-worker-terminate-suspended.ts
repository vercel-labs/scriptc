import { Worker, isMainThread, parentPort } from "node:worker_threads";
async function wait(): Promise<void> {
  const value = ["owned", "stack"];
  try { await new Promise<void>(() => {}); console.log(value.join(" ")); }
  finally { console.log("finally"); }
}
function* values(): Generator<string> {
  const value = ["owned", "generator"];
  try { yield value.join(" "); }
  finally { console.log("generator finally"); }
}
if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  worker.on("message", async () => { console.log("ready"); console.log("terminated", await worker.terminate()); });
  worker.on("exit", (code: number) => console.log("exit", code));
} else {
  wait();
  const generator = values(); generator.next();
  parentPort!.on("message", () => {});
  parentPort!.postMessage("ready");
}
