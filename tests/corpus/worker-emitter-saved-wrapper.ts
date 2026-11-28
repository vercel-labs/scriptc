// A once() wrapper saved from rawListeners() keeps working after the Worker it
// came from is gone: it fires its listener once and answers undefined on a
// later call, as Node's wrapper does, and the worker's own bookkeeping is no
// longer reachable through the emitter the wrapper holds.
import { Worker, isMainThread } from "node:worker_threads";

function savedMessageWrapper(): () => void {
  const worker = new Worker(new URL(import.meta.url));
  worker.once("message", () => console.log("fired"));
  return worker.rawListeners("message")[0] as () => void;
}

if (isMainThread) {
  const wrappers = [savedMessageWrapper(), savedMessageWrapper(), savedMessageWrapper()];
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const wrapper of wrappers) wrapper();
  for (const wrapper of wrappers) wrapper();
  console.log("done");
} else {
  // exit at once, leaving the once('message') registration unfired
}
