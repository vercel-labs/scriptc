import { parentPort, workerData, isMainThread } from "node:worker_threads";
let local = 10;
local += workerData as number;
parentPort!.postMessage(isMainThread ? -1 : local);
