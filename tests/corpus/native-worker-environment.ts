import { Worker, isMainThread, parentPort, workerData, threadId } from "node:worker_threads";

if (isMainThread) {
  process.env.SCRIPTC_WORKER_ENV_TEST = "parent";
  const worker = new Worker(new URL(import.meta.url), { workerData: 1, argv: ["one", 2, true, "café"] });
  worker.on("message", (value: unknown) => console.log(JSON.stringify(value)));
  worker.on("exit", (code: number) => console.log("exit", code, process.env.SCRIPTC_WORKER_ENV_TEST));
} else if ((workerData as number) === 1) {
  const before = process.env.SCRIPTC_WORKER_ENV_TEST;
  const args = process.argv.slice(2);
  process.env.SCRIPTC_WORKER_ENV_TEST = "child";
  const worker = new Worker(new URL(import.meta.url), { workerData: 2 });
  worker.on("message", (value: unknown) => {
    parentPort!.postMessage({ args, before, after: process.env.SCRIPTC_WORKER_ENV_TEST, nested: value });
  });
} else {
  const failures: string[] = [];
  try { process.chdir("."); } catch (error) {
    if (error instanceof Error) failures.push(error.message);
    else throw error;
  }
  const mask = process.umask();
  try { process.umask(mask); } catch (error) {
    if (error instanceof Error) failures.push(error.message);
    else throw error;
  }
  parentPort!.postMessage({ environment: process.env.SCRIPTC_WORKER_ENV_TEST, worker: threadId > 0, failures });
}
