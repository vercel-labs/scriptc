// A worker's entry module is itself a Node island module: the native
// program has no compiled module for the worker thread to run, so the
// build refuses by name (SC8012).
import { Worker } from "node:worker_threads";
import { answer } from "./w.cjs";

console.log("main", answer());
const worker = new Worker(new URL("./w.cjs", import.meta.url));
worker.on("exit", (code: number) => console.log(code));
