// The worker entry, shipped as real source with the island tree: this
// thread's copy of state.ts starts at zero, whatever the program's copy
// holds.
import { parentPort } from "node:worker_threads";
import { bump, count } from "./state.ts";

parentPort?.on("message", (value: number) => {
  parentPort?.postMessage(`echo=${value} worker=${bump()},${bump()},${bump()} count=${count}`);
});
