import { Worker, isMainThread, parentPort } from "node:worker_threads";

// worker.cpuUsage([prev]) asks the worker's thread for its own CPU usage:
// a promise of {user, system} microseconds, a rejection with
// ERR_WORKER_NOT_RUNNING before 'online' and after exit, and Node's
// validation of a `prev` reading. The numbers are the machine's, so the
// program prints their shape and the promise's ordering only.
function describe(usage: { user: number; system: number }): string {
  const keys = Object.keys(usage).join(",");
  const finite = Number.isFinite(usage.user) && Number.isFinite(usage.system);
  return `${keys} finite=${finite} nonnegative=${usage.user >= 0 && usage.system >= 0}`;
}

if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  const rejects = (label: string, run: () => unknown) => {
    try {
      run();
      console.log(label, "no throw");
    } catch (error: any) {
      console.log(label, error.code, error.message);
    }
  };
  rejects("prev number", () => worker.cpuUsage(-1 as any));
  rejects("prev array", () => worker.cpuUsage([] as any));
  rejects("prev boolean", () => worker.cpuUsage(true as any));
  rejects("prev string member", () => worker.cpuUsage({ user: "1", system: 1 } as any));
  rejects("prev missing member", () => worker.cpuUsage({ user: 1 } as any));
  rejects("prev negative member", () => worker.cpuUsage({ user: -1, system: 1 }));
  // a falsy `prev` is no reading at all: the call skips validation
  const falsy = worker.cpuUsage(null as any);
  falsy.catch(() => {});
  console.log("falsy prev accepted", typeof falsy.then);

  // not running yet: the rejection carries Node's code, not a throw
  worker.cpuUsage().then(
    () => console.log("early resolved"),
    (error: any) => console.log("early rejected", error.code, error.message),
  );

  worker.on("online", async () => {
    const first = await worker.cpuUsage();
    console.log("usage", describe(first));
    const second = await worker.cpuUsage();
    console.log("second", describe(second));
    const delta = await worker.cpuUsage(first);
    console.log("delta", describe(delta));
    await worker.terminate();
  });

  worker.on("exit", async () => {
    try {
      await worker.cpuUsage();
      console.log("after exit resolved");
    } catch (error: any) {
      console.log("after exit rejected", error.code, error.message);
    }
  });
} else {
  parentPort!.on("message", () => {});
}
