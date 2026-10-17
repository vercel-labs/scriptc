import { BroadcastChannel, Worker, isMainThread } from "node:worker_threads";

// BroadcastChannel across threads: the main thread's channel and a
// worker's channel with the same name hear each other, a sender never
// hears its own message, and closing both lets the worker exit.
if (isMainThread) {
  const bc = new BroadcastChannel("jobs");
  bc.onmessage = (e: MessageEvent) => {
    console.log("main got", JSON.stringify(e.data));
    if (e.data === "ready") bc.postMessage("work");
    if (e.data === "done:work") {
      bc.postMessage("bye");
      bc.close();
    }
  };
  const worker = new Worker(new URL(import.meta.url));
  worker.on("exit", (code: number) => console.log("exit", code));
} else {
  const bc = new BroadcastChannel("jobs");
  bc.onmessage = (e: MessageEvent) => {
    if (e.data === "work") bc.postMessage("done:" + e.data);
    if (e.data === "bye") bc.close();
  };
  bc.postMessage("ready");
}
