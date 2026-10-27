// worker.threadName read while the worker runs stays a usable string after
// the worker exits and the Worker object is released.
import { Worker, isMainThread, parentPort, threadName } from "node:worker_threads";

async function run(name) {
  const worker = new Worker(new URL(import.meta.url), { name });
  const kept = worker.threadName;
  await new Promise((resolve) => worker.once("exit", resolve));
  return kept;
}

if (isMainThread) {
  const fromFunction = await run("function worker");
  const names = [];
  for (const name of ["first worker", "  second  "]) {
    let worker = new Worker(new URL(import.meta.url), { name });
    names.push(worker.threadName);
    const exited = new Promise((resolve) => worker.once("exit", resolve));
    const inner = await new Promise((resolve) => worker.once("message", resolve));
    await exited;
    console.log("after exit", JSON.stringify(worker.threadName), JSON.stringify(inner));
    worker = null;
  }
  // allocations that would reuse the released names' storage
  const filler = [];
  for (let i = 0; i < 1000; i++) filler.push("x".repeat(i % 64));
  console.log("kept", filler.length, JSON.stringify(names), names.map((n) => n.length).join(","));
  console.log("joined", names.join("|").toUpperCase());
  console.log("from function", JSON.stringify(fromFunction), fromFunction.length, fromFunction.toUpperCase());
} else {
  const own = threadName;
  parentPort.postMessage(`${own}:${own.length}`);
}
