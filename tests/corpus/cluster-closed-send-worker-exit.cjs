// A worker queues a closed-channel send and stops before its next tick
// runs: the queued callback, error and captured async context are released
// at worker teardown (a sanitized build reports no leak), and the primary
// still sees the worker exit.
const cluster = require("cluster");

if (cluster.isPrimary) {
  const keepAlive = setTimeout(() => {}, 5000);
  const worker = cluster.fork();
  worker.on("message", (message) => {
    if (message.ready) worker.disconnect();
  });
  worker.on("exit", (code, signal) => {
    clearTimeout(keepAlive);
    console.log("exit", code, signal);
  });
} else {
  const { AsyncLocalStorage } = require("node:async_hooks");
  const als = new AsyncLocalStorage();
  cluster.worker.on("message", (message) => {
    if (message.go) cluster.worker.disconnect();
  });
  cluster.worker.on("disconnect", () => {
    als.run({ label: "closed" }, () => {
      cluster.worker.send({ late: 1 }, () => console.log("late callback"));
    });
    process.exit(0);
  });
  cluster.worker.send({ ready: true });
}
