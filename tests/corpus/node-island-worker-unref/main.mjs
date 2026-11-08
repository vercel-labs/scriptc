// @requires-libnode
// The main thread's loop runs dry while a worker without a reference is
// still calling the Node island: the process ends, as under Node, which
// terminates such a worker. The worker waits for the main thread to answer
// each call, and the main thread, ending, waits for the worker: the
// worker's wait must give way when it is asked to stop.
import { Worker, isMainThread } from "node:worker_threads";
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");
if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  worker.unref();
  setTimeout(() => console.log("main done", lib.echo("x")), 30);
} else {
  for (;;) lib.echo("y");
}
