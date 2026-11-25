// A Worker entry computed from this module's own URL with a string method:
// `import.meta.url` is a string, `replace` answers the sibling's URL text,
// and `new URL` makes it the entry. The build bounds the entry to that
// sibling (not to this module, the receiver's URL) and starts it natively.
import { Worker } from "node:worker_threads";

function entry(): URL {
  return new URL(import.meta.url.replace("main.ts", "job.ts"));
}

const worker = new Worker(entry(), { workerData: 20 });
worker.once("message", (value: number) => console.log("worker", value));
worker.once("exit", (code: number) => console.log("exit", code));
