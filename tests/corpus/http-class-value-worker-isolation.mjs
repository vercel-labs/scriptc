import * as http from "node:http";
import { Worker, isMainThread, workerData } from "node:worker_threads";

// A worker's module graph is its own: the class values `http.IncomingMessage`
// and `http.ServerResponse` (and their prototype objects) belong to the
// worker that reads them, so a mutation made in one worker is not visible in
// another or in the main thread.
const marker = () => http.IncomingMessage.prototype.workerTag;

if (isMainThread) {
  const run = (mode) =>
    new Promise((resolve) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: mode });
      worker.on("message", (message) => console.log(mode, message));
      worker.on("error", (err) => console.log(mode, "error", err.message));
      worker.on("exit", (code) => {
        console.log(mode, "exit", code);
        resolve();
      });
    });
  console.log("main before", marker(), http.IncomingMessage.length, http.ServerResponse.length);
  run("writer").then(() => {
    console.log("main after writer", marker());
    return run("reader");
  }).then(() => {
    console.log("main end", marker());
  });
} else if (workerData === "writer") {
  const before = marker();
  http.IncomingMessage.prototype.workerTag = "writer";
  console.log("writer", before, marker(), http.IncomingMessage === http.IncomingMessage);
  process.exit(0);
} else {
  console.log("reader", marker(), http.IncomingMessage === http.IncomingMessage);
  http.IncomingMessage.prototype.workerTag = "reader";
  console.log("reader after own write", marker());
  process.exit(0);
}
