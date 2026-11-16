import { Worker, isMainThread, workerData } from "node:worker_threads";
import { fileURLToPath } from "node:url";
const self = fileURLToPath(import.meta.url);

// Without the stdout option a worker's writes go to the process's own output
// and the parent's Readable carries nothing left over: a parent that never
// reads it must not accumulate chunks. A parent that reads it — a 'readable'
// listener with read() — still receives them.
if (isMainThread) {
  const quiet = new Worker(self, { workerData: "flood" });
  quiet.on("exit", () => {
    console.log("left in the unread stream", quiet.stdout.readableLength > 0);

    const reader = new Worker(self, { workerData: "one" });
    reader.stdout.on("readable", () => {
      const chunk = reader.stdout.read();
      if (chunk) console.log("readable got", String(chunk).trim());
    });
    reader.on("exit", () => console.log("left in the read stream", reader.stdout.readableLength > 0));
  });
} else if (workerData === "flood") {
  for (let i = 0; i < 200; i++) console.log("line", i);
} else {
  console.log("only line");
}
