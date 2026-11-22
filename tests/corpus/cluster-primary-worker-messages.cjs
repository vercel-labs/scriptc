// Messages travel both ways: the primary's send reaches the worker's
// cluster.worker 'message' listener (Node's Worker wraps the process and
// forwards its messages), the worker replies, and a send after the
// channel disconnected answers false and calls its callback with
// ERR_IPC_CHANNEL_CLOSED instead of a silent success.
const cluster = require("cluster");

if (cluster.isPrimary) {
  const worker = cluster.fork();
  // Keeps the primary's loop alive until the worker's exit, so the
  // disconnect and exit events below are always delivered.
  const keepAlive = setTimeout(() => {}, 5000);
  worker.on("online", () => worker.send({ ping: 1 }));
  worker.on("message", (message) => {
    console.log("primary message", JSON.stringify(message));
    if (message.echo) worker.disconnect();
  });
  worker.on("disconnect", () => {
    const sent = worker.send({ late: 1 }, (error) => {
      console.log("late callback", error && error.code, error && error.message);
    });
    console.log("late send", sent, worker.isConnected());
  });
  worker.on("exit", (code, signal) => {
    clearTimeout(keepAlive);
    console.log("exit", code, signal);
  });
} else {
  cluster.worker.on("message", (message) => {
    cluster.worker.send({ echo: message.ping });
  });
  cluster.worker.send({ ready: true });
}
