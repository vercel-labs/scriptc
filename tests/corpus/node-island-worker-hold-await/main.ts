// @requires-libnode
// A worker thread holds an island object across its own awaits: between
// two uses of the object the worker's loop turns (a timer, a promise job),
// while the main thread makes and drops island objects of the same class.
// The object is the worker's, and it is the same object after every await.
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import { Counter, snapshot } from "counter-pkg";

if (isMainThread) {
  let frames = 0;
  const timer = setInterval(() => {
    for (let i = 0; i < 20; i++) if (snapshot(new Counter(frames + i)).length > 0) frames++;
  }, 1);
  const worker = new Worker(new URL(import.meta.url));
  worker.on("message", (message: string) => console.log(message));
  worker.on("exit", (code: number) => {
    clearInterval(timer);
    console.log("exit", code, frames > 0);
  });
} else {
  const pause = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(() => resolve(undefined), ms));
  const run = async (): Promise<void> => {
    const held = new Counter(10);
    const others: Counter[] = [];
    const lines: string[] = [];
    for (let round = 0; round < 30; round++) {
      held.bump(round);
      others.push(new Counter(round));
      await pause(1);
      lines.push(`${round}:${held.total}`);
      await Promise.resolve();
      held.bump(1);
      if (others.length > 5) others.shift();
    }
    parentPort!.postMessage(lines.join(" "));
    parentPort!.postMessage(`${snapshot(held)} ${others.map((other) => other.total).join(",")}`);
  };
  void run();
}
