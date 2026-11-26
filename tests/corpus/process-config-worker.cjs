// process.config answers the same build description from a worker: the ICU
// flag is a property of the linked binary, not of the thread that reads it.
const { Worker, isMainThread, parentPort } = require("node:worker_threads");
const key = "v8_enable_i18n_support";
if (isMainThread) {
  console.log("main", process.config.variables[key], process.config.variables.v8_enable_i18n_support);
  const worker = new Worker(__filename);
  worker.on("message", (value) => console.log("worker", value));
  worker.on("error", (error) => console.log("worker-error", error.message));
} else {
  parentPort.postMessage(process.config.variables[key]);
}
