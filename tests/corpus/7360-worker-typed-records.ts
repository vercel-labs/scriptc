import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

// Typed records posted to a worker and back keep their keys, order and
// values, as in Node: records with optional fields, nested records and a
// record in workerData.
type Point = { x: number; y: number };
type Job = { id: number; label: string; urgent: boolean; at: Point; note?: string };
type Reply = { id: number; sum: number; label: string };

if (isMainThread) {
  const start: Point = { x: 10, y: 20 };
  const worker = new Worker(new URL(import.meta.url), { workerData: start });
  const replies: string[] = [];
  worker.on("message", (reply: Reply) => {
    replies.push(`${JSON.stringify(reply)} ${Object.keys(reply).join(",")}`);
    if (replies.length === 3) {
      for (const line of replies) console.log(line);
      void worker.terminate();
    }
  });
  const jobs: Job[] = [
    { id: 1, label: "a", urgent: false, at: { x: 1, y: 2 } },
    { id: 2, label: "b", urgent: true, at: { x: 3, y: 4 }, note: "n" },
    { id: 3, label: "", urgent: false, at: { x: -1, y: 0.25 } },
  ];
  for (const job of jobs) worker.postMessage(job);
} else {
  const origin = workerData as Point;
  parentPort!.on("message", (job: Job) => {
    const reply: Reply = {
      id: job.id,
      sum: job.at.x + job.at.y + origin.x + origin.y,
      label: `${job.label}${job.urgent ? "!" : ""}${job.note ?? ""}`,
    };
    parentPort!.postMessage(reply);
  });
}
