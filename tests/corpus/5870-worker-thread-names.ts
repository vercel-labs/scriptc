import { Worker, isMainThread, parentPort, threadId, threadName, workerData } from "node:worker_threads";

// The Worker name option: a truthy name must be a string and is trimmed,
// any other value selects "WorkerThread"; threadName reports it inside the
// worker and on the Worker until exit (null afterwards), and is "" in the
// main thread.
if (isMainThread) {
  console.log("main", threadId, JSON.stringify(threadName));
  for (const name of [5, true, {}] as unknown[]) {
    try {
      const options: Record<string, unknown> = { name };
      new Worker(new URL(import.meta.url), options);
    } catch (e) {
      const err = e as Error & { code?: string };
      console.log(JSON.stringify(name), err.name, err.code, err.message);
    }
  }
  const names: unknown[] = ["  reader one  ", "", "   ", 0, null, undefined, "a\tb  "];
  let next = 0;
  const run = (): void => {
    if (next >= names.length) return;
    const name = names[next++];
    const options: Record<string, unknown> = { name, workerData: next };
    const worker = new Worker(new URL(import.meta.url), options);
    console.log(JSON.stringify(name), "threadName", JSON.stringify(worker.threadName));
    worker.on("message", (m: unknown) => console.log("  worker saw", JSON.stringify(m)));
    worker.on("exit", (code: number) => {
      console.log("  exit", code, JSON.stringify(worker.threadName));
      run();
    });
  };
  run();
} else {
  parentPort!.postMessage([workerData, threadName, threadId > 0]);
}
