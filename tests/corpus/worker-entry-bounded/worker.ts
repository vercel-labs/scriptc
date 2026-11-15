import { parentPort, workerData } from "node:worker_threads";

parentPort!.postMessage((workerData as number) * 2);
