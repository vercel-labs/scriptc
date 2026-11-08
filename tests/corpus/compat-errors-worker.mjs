// Worker errors of Node's errors chapter: an operation on the process
// that a worker thread may not perform (ERR_WORKER_UNSUPPORTED_OPERATION),
// and how a value thrown in a worker reaches the 'error' event of its
// owner: an Error keeps its class, name and message, another value
// arrives as itself.
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

if (isMainThread) {
  await new Promise((resolve) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: "chdir" });
    worker.on("message", (line) => console.log(line));
    worker.on("exit", (code) => {
      console.log("chdir exit", code);
      resolve(undefined);
    });
  });
  for (const thrown of ["string", "number", "object", "error", "typeerror"]) {
    await new Promise((resolve) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: thrown });
      worker.on("error", (e) => {
        const text = typeof e === "object" ? JSON.stringify(e) : String(e);
        console.log(thrown, typeof e, e instanceof Error, e instanceof TypeError, e && e.name, e && e.message, text);
      });
      worker.on("exit", (code) => {
        console.log(thrown, "exit", code);
        resolve(undefined);
      });
    });
  }
} else if (workerData === "chdir") {
  try {
    process.chdir("/");
    parentPort.postMessage("chdir no throw");
  } catch (e) {
    parentPort.postMessage(["chdir", e instanceof TypeError, e.name, e.code, e.message].join(" | "));
  }
} else {
  if (workerData === "string") throw "text";
  if (workerData === "number") throw 5;
  if (workerData === "object") throw { a: 1 };
  if (workerData === "error") throw new Error("boom");
  if (workerData === "typeerror") throw new TypeError("bad");
}
