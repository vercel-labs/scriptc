// A Node island used from a native worker thread cannot run: Node.js
// initializes once per process, so the island on the second thread aborts
// it. The build refuses by name (SC8012) instead of compiling a crash.
import { Worker } from "node:worker_threads";

const worker = new Worker(new URL("./w.ts", import.meta.url));
worker.on("exit", (code) => console.log(code));
