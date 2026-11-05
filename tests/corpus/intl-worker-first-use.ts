// @requires-icu
// @env: TZ=UTC,LC_ALL=en_US.UTF-8
// The program's first ICU calls come from eight worker threads at once:
// each worker formats a number and a date as its first Intl use. Every
// worker answers, and none reports the ICU data as missing while another
// thread is still loading it.
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

if (isMainThread) {
  const results: string[] = [];
  let pending = 8;
  for (let i = 0; i < 8; i++) {
    const worker = new Worker(new URL(import.meta.url), { workerData: i });
    worker.on("message", (text: string) => {
      results.push(text);
    });
    worker.on("exit", () => {
      pending--;
      if (pending === 0) {
        results.sort();
        for (const text of results) console.log(text);
      }
    });
  }
} else {
  const index = workerData as number;
  let text: string;
  try {
    const number = (1234567.5 + index).toLocaleString();
    const date = new Date(Date.UTC(2024, 0, 1 + index, 9, 30)).toLocaleString();
    text = `${index} ${number} ${date}`;
  } catch (error) {
    text = `${index} threw ${error instanceof Error ? error.message : String(error)}`;
  }
  parentPort!.postMessage(text);
}
