// worker[Symbol.asyncDispose]() terminates the worker and resolves with
// undefined after its 'exit' event; `await using` disposes a Worker at the
// end of its block.
import { Worker, isMainThread, parentPort } from "node:worker_threads";

if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  const dispose = worker[Symbol.asyncDispose];
  console.log(typeof dispose, dispose.name, dispose.length);
  worker.on("exit", (code) => console.log("exit", code));
  await new Promise((resolve) => worker.once("message", resolve));
  const result = await worker[Symbol.asyncDispose]();
  console.log("disposed", result);
  console.log("again", await worker[Symbol.asyncDispose]());
  {
    await using scoped = new Worker(new URL(import.meta.url));
    scoped.on("exit", (code) => console.log("scoped exit", code));
    await new Promise((resolve) => scoped.once("message", resolve));
    console.log("leaving block");
  }
  console.log("after block");
} else {
  parentPort.postMessage("ready");
  setInterval(() => {}, 1000);
}
