// @requires-libnode
// A worker without a reference is made before the Node island starts, so the
// process's end stops Node before it joins the worker: the worker is still
// making and dropping island objects then. The main thread loads the library
// late, prints one label and finishes; the process ends as under Node, which
// terminates such a worker.
import { Worker, isMainThread } from "node:worker_threads";
import { requireModule } from "@scriptc/node";

if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  worker.unref();
  setTimeout(() => {
    const depot = requireModule("./lib.cjs");
    console.log("main done", depot.label(7).code);
  }, 30);
} else {
  const depot = requireModule("./lib.cjs");
  for (;;) depot.label(1);
}
