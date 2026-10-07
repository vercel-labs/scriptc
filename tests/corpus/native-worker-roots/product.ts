import * as threads from "node:worker_threads";
let local = 10;
local *= threads.workerData as number;
threads.parentPort!.postMessage(threads.isMainThread ? -1 : local);
