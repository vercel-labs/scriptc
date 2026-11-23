// cluster.disconnect(callback): disconnects every connected worker and runs
// the callback once the workers list empties; the worker itself exits.
const cluster = require("cluster");

if (cluster.isPrimary) {
  const w = cluster.fork();
  w.on("message", (message) => {
    console.log("message", JSON.stringify(message));
    cluster.disconnect(() => console.log("disconnect done", Object.keys(cluster.workers).length));
  });
  w.on("disconnect", () => console.log("worker disconnect", w.isConnected()));
  cluster.on("disconnect", (worker) => console.log("cluster disconnect", worker.id));
  w.on("exit", (code, signal) => console.log("worker exit", code, signal));
} else {
  process.send({ ready: cluster.worker.id });
}
