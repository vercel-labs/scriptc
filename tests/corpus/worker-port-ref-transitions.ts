// A MessagePort's loop reference changes only on the 'message' listener
// transitions, as Node's setupPortReferencing does: removing one of several
// message listeners (a `{ once: true }` listener firing) must not re-reference
// a port the program unref()ed, and removing a non-'message' listener must
// not touch the reference at all. Both workers must exit on their own.
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

if (isMainThread) {
  const exits: number[] = [];
  function start(mode: number, post: boolean): void {
    const worker = new Worker(new URL(import.meta.url), { workerData: mode });
    worker.on("message", () => {
      if (post) worker.postMessage(1);
    });
    worker.on("exit", (code: number) => {
      exits.push(code);
      if (mode === 1) start(2, false);
      else {
        console.log("exits", JSON.stringify(exits));
        process.exit(0);
      }
    });
  }
  start(1, true);
  setTimeout(() => {
    console.log("timeout", JSON.stringify(exits));
    process.exit(1);
  }, 3000);
} else {
  if (workerData === 1) {
    // Two message listeners, then an explicit unref: the once listener
    // firing removes itself while the other remains, which changes nothing.
    parentPort!.addEventListener("message", () => {}, { once: true });
    parentPort!.addEventListener("message", () => {});
    parentPort!.unref();
    parentPort!.postMessage(1);
  } else {
    // One message listener and an explicit unref, then a non-'message'
    // listener is added and removed: the reference must stay as it was.
    const onClose = (): void => {};
    parentPort!.addEventListener("message", () => {});
    parentPort!.unref();
    parentPort!.addEventListener("close", onClose);
    parentPort!.removeEventListener("close", onClose);
    parentPort!.postMessage(2);
  }
}
