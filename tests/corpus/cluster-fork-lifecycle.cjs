// node:cluster primary/worker lifecycle: fork() restarts this program as a
// worker, the Worker object, the primary's and the worker's cluster state,
// and the worker's own cluster.worker handle. The worker prints nothing:
// it reports through cluster.worker.send, so the primary owns every line.
const cluster = require("cluster");

if (cluster.isPrimary) {
  const w = cluster.fork({ CLUSTER_ROLE: "alpha" });
  console.log("forked", w.id, w.isConnected(), w.isDead(), cluster.workers[w.id] === w);
  cluster.on("fork", (worker) => console.log("cluster fork", worker.id));
  cluster.on("online", (worker) => console.log("cluster online", worker.id, worker === w));
  cluster.on("message", (worker, message) => console.log("cluster message", worker.id, JSON.stringify(message)));
  w.on("message", (message) => {
    console.log("worker message", JSON.stringify(message));
    w.disconnect();
  });
  w.on("disconnect", () => console.log("worker disconnected", w.isConnected(), w.isDead(), Object.keys(cluster.workers).length));
  w.on("exit", (code, signal) => console.log("worker exit", code, signal, w.isDead(), w.exitedAfterDisconnect));
} else {
  cluster.worker.send({
    isWorker: cluster.isWorker,
    isPrimary: cluster.isPrimary,
    isMaster: cluster.isMaster,
    id: cluster.worker.id,
    role: process.env.CLUSTER_ROLE,
    uniqueId: process.env.NODE_UNIQUE_ID,
  });
}
