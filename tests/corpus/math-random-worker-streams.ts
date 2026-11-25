import { Worker, isMainThread, parentPort } from "node:worker_threads";

// Every thread has its own Math.random stream: the main thread and four
// workers each draw 64 numbers, and no number appears in two threads. The
// main thread draws before the workers start and again after they finish,
// so a worker that copied or shared the main thread's generator state would
// repeat one of the two runs.
const DRAWS = 64;

function draw(): number[] {
  const out: number[] = [];
  for (let i = 0; i < DRAWS; i++) out.push(Math.random());
  return out;
}

if (isMainThread) {
  const before = draw();
  const streams: number[][] = [before];
  const WORKERS = 4;
  let exited = 0;
  for (let w = 0; w < WORKERS; w++) {
    const worker = new Worker(new URL(import.meta.url));
    worker.on("message", (m: number[]) => {
      streams.push(m);
    });
    worker.on("exit", () => {
      exited++;
      if (exited < WORKERS) return;
      streams.push(draw());
      const seen = new Set<number>();
      let total = 0;
      let inRange = true;
      for (const stream of streams) {
        total += stream.length;
        for (const r of stream) {
          if (!(r >= 0 && r < 1)) inRange = false;
          seen.add(r);
        }
      }
      console.log("streams", streams.length, "draws", total);
      console.log("in range", inRange);
      console.log("no value shared between threads or runs", seen.size === total);
    });
  }
} else {
  parentPort!.postMessage(draw());
}
