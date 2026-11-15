// @requires-libnode
// A worker thread scales a large picture through a Node island package
// while the main thread renders with the same package: the picture travels
// to the worker as text (2 MB of base64), the worker's one long island call
// decodes and scales it, and the main thread keeps drawing frames from a
// timer meanwhile. The worker's module imports the island package itself.
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { decode, frame } from "picture-pkg";

interface Job {
  width: number;
  height: number;
  text: string;
}

if (isMainThread) {
  const width = 1500;
  const height = 1000;
  const pixels = new Uint8Array(width * height);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 31 + (i >> 8)) & 255;
  const job: Job = { width, height, text: Buffer.from(pixels).toString("base64") };
  let frames = 0;
  let drawn = 0;
  const timer = setInterval(() => {
    drawn += frame(frames++, 40).length;
  }, 1);
  const worker = new Worker(new URL(import.meta.url), { workerData: job });
  worker.on("message", (message: string) => console.log("worker", message));
  worker.on("error", (error: Error) => console.log("worker error", error.message));
  worker.on("exit", (code: number) => {
    clearInterval(timer);
    console.log("exit", code, frames > 0, drawn === frames * 40);
  });
} else {
  const job = workerData as Job;
  const lines: string[] = [];
  for (const target of [300, 150, 64]) {
    const small = decode(job.text, job.width, job.height, target);
    lines.push(`${small.width}x${small.height} ${small.checksum} ${small.preview}`);
  }
  parentPort!.postMessage(lines.join(" | "));
}
