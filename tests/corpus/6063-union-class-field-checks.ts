// A checked conversion of a dynamic value to a union of object types picks
// the member whose fields match, including a field of type `C | undefined`
// that holds an instance of the class C: workerData read as such a union,
// and an unknown value asserted to it, give the instance or undefined.
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { publish } from "@scriptc/threads";

class Job {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
}

interface WithJob {
  readonly kind: "job";
  readonly job: Job | undefined;
}
interface Plain {
  readonly kind: "plain";
  readonly note: string;
}
interface Counted {
  readonly kind: "counted";
  readonly count: number;
  readonly last: Job | undefined;
}
type Data = WithJob | Plain | Counted;

function describe(data: Data): string {
  switch (data.kind) {
    case "job":
      return data.job === undefined ? "job none" : `job ${data.job.name}`;
    case "plain":
      return `plain ${data.note}`;
    case "counted":
      return `counted ${data.count} ${data.last?.name ?? "none"}`;
  }
}

function run(data: Data): Promise<void> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: data });
    worker.on("message", (message) => console.log("worker:", message));
    worker.on("error", (error) => console.log("worker failed:", String(error)));
    worker.on("exit", () => resolve());
  });
}

if (isMainThread) {
  const values: unknown[] = [
    { kind: "job", job: new Job("local") },
    { kind: "job", job: undefined },
    { kind: "plain", note: "text" },
    { kind: "counted", count: 2, last: new Job("tail") },
  ];
  for (const value of values) console.log("local:", describe(value as Data));
  const shared = publish(new Job("shared"));
  await run({ kind: "job", job: shared });
  await run({ kind: "job", job: undefined });
  await run({ kind: "plain", note: "worker" });
  await run({ kind: "counted", count: 3, last: shared });
} else {
  parentPort!.postMessage(describe(workerData as Data));
}
