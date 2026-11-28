// A worker that exits with a closed-channel send queued drops that send's
// callback and captured async-local context at thread teardown. One
// worker's teardown must not disarm another worker's: the second worker
// still holds its queue when the first one exits.
import { fork } from "node:child_process";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

function queueClosedSend(done: () => void): void {
  const child = fork(new URL("./child.ts", import.meta.url), [], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  child.on("disconnect", () => {
    child.send({ payload: 1 }, () => {});
    done();
  });
}

if (!isMainThread) {
  if (workerData === "hold") {
    queueClosedSend(() => {
      parentPort?.postMessage("queued");
      parentPort?.once("message", () => {
        console.log("holder exit");
        process.exit(0);
      });
    });
  } else {
    queueClosedSend(() => {
      console.log("first exit");
      process.exit(0);
    });
  }
} else {
  const holder = new Worker(new URL(import.meta.url), { workerData: "hold" });
  holder.on("message", () => {
    const first = new Worker(new URL(import.meta.url), { workerData: "exit" });
    first.on("exit", () => holder.postMessage("go"));
  });
  holder.on("exit", () => console.log("done"));
}
