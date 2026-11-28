// cluster.disconnect(callback): disconnects every connected worker and runs
// the callback once the workers list empties; the worker itself exits.
const cluster = require("cluster");

if (cluster.isPrimary) {
  const w = cluster.fork();
  // The disconnect callback and the child's exit are separate events, and
  // the order they arrive in is the host's (Node and a compiled program
  // differ under load), so both are reported together once both have
  // arrived, in one fixed order.
  let disconnectDone = null;
  let exitEvent = null;
  const reportEnd = () => {
    if (disconnectDone === null || exitEvent === null) return;
    console.log("disconnect done", disconnectDone);
    console.log("worker exit", exitEvent.code, exitEvent.signal);
  };
  w.on("message", (message) => {
    console.log("message", JSON.stringify(message));
    cluster.disconnect(() => {
      disconnectDone = Object.keys(cluster.workers).length;
      reportEnd();
    });
  });
  w.on("disconnect", () => console.log("worker disconnect", w.isConnected()));
  cluster.on("disconnect", (worker) => console.log("cluster disconnect", worker.id));
  w.on("exit", (code, signal) => {
    exitEvent = { code, signal };
    reportEnd();
  });
} else {
  process.send({ ready: cluster.worker.id });
}
