// Structured clones a worker receives: workerData and message payloads.
// Two casts of workerData are one object; a message payload converts once.
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

type Job = { name: string; point: { x: number; y: number }; tags: string[] };

if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { name: "job", point: { x: 1, y: 2 }, tags: ["a"] },
  });
  worker.on("message", (message: unknown) => {
    if (typeof message === "string") {
      console.log(message);
      return;
    }
    const reply = message as Job;
    reply.tags.push("main");
    console.log("reply", reply.name, reply.point.x, reply.tags.join(","));
  });
} else {
  const job = workerData as Job;
  const same = workerData as Job;
  job.point.x = 10;
  same.tags.push("worker");
  // Node forwards a worker's stdout to the parent asynchronously, so the
  // worker's line goes through the port: messages on one port keep their
  // order, and the line prints before the reply.
  parentPort!.postMessage(`worker ${same.point.x} ${job.tags.join(",")} ${job === same}`);
  parentPort!.postMessage(job);
}
