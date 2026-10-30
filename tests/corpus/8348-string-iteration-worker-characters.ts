import { Worker, isMainThread, parentPort } from "node:worker_threads";

// The one-character strings of U+0080..U+07FF that string iteration returns
// are shared by every thread. A worker that is the first to iterate them
// and exits without sharing anything else leaves them in use: the main
// thread iterates the same characters after the worker's memory goes back.

const text = "aé ñ ß ü Ω ж א ع ߿";

function codes(s: string): string {
  const out: string[] = [];
  for (const c of s) out.push(`${c.length}:${c.charCodeAt(0).toString(16)}`);
  return out.join(" ");
}

function runWorker(): Promise<number> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url));
    let count = -1;
    worker.on("message", (value: number) => {
      count = value;
    });
    worker.on("error", reject);
    worker.on("exit", () => resolve(count));
  });
}

async function main(): Promise<void> {
  console.log("worker", await runWorker());
  // The worker's memory goes back shortly after it exits.
  await new Promise((resolve) => setTimeout(resolve, 300));
  console.log("main", codes(text));
  console.log("spread", [...text].join("|"));
  console.log("from", Array.from("ñandú").map((c) => c.length).join(","));
}

if (isMainThread) {
  void main();
} else {
  let count = 0;
  for (const c of text) count += c.length;
  count += [...text].length + Array.from("ñandú").length;
  parentPort!.postMessage(count);
}
