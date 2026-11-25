import { Worker } from "node:worker_threads";

// The worker's script never names worker_threads. Node still answers
// worker.cpuUsage() from that thread, so a native worker has to watch its
// mailbox whether or not its script uses the module.
const quiet = new Worker(new URL("./worker.ts", import.meta.url));
console.log(
  "quiet shape",
  Object.keys(quiet.resourceLimits!).join(","),
);

quiet.on("online", async () => {
  const usage = await quiet.cpuUsage();
  console.log(
    "quiet usage",
    Object.keys(usage).join(","),
    Number.isFinite(usage.user) && Number.isFinite(usage.system),
    usage.user >= 0 && usage.system >= 0,
  );
  const delta = await quiet.cpuUsage(usage);
  console.log("quiet delta", Object.keys(delta).join(","), delta.user >= 0);
  await quiet.terminate();
});
