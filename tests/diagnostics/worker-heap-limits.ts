// A Worker's resourceLimits heap fields: a compiled program has one heap
// for every thread, so a heap limit cannot be enforced. The build refuses
// the request by name rather than starting a worker without the bound the
// caller asked for.
import { Worker } from "node:worker_threads";

const worker = new Worker(new URL(import.meta.url), {
  resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 2 },
});
worker.on("exit", (code: number) => console.log(code));
