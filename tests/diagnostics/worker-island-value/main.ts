// A module that only worker threads run (job.ts) passes its Node island
// values a worker thread cannot pass: the build refuses each by name
// (SC8012), where the binary would throw ERR_SCRIPTC_ISLAND_WORKER_VALUE at
// the call. The main thread owns the island and passes the same kinds here.
import { Worker } from "node:worker_threads";
import { each, sum } from "crossing-pkg";

console.log(sum(new Uint8Array(4)), each((n: number) => n + 1));
const worker = new Worker(new URL("./job.ts", import.meta.url));
worker.on("message", (message: unknown) => console.log(message));
