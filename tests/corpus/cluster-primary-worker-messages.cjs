// Messages travel both ways: the primary's send reaches the worker's
// cluster.worker 'message' listener (Node's Worker wraps the process and
// forwards its messages), the worker replies, and a send after the
// channel disconnected answers false and calls its callback with
// ERR_IPC_CHANNEL_CLOSED instead of a silent success.
const cluster = require("cluster");

if (cluster.isPrimary) {
  const w = cluster.fork();
  w.on("online", () => w.send({ ping: 1 }));
  w.on("message", (message) => {
    console.log("primary message", JSON.stringify(message));
    w.disconnect();
  });
  w.on("disconnect", () => {
    const sent = w.send({ late: 1 }, (error) => {
      console.log("late callback", error && error.code, error && error.message);
    });
    console.log("late send", sent, w.isConnected());
  });
  w.on("exit", (code, signal) => console.log("exit", code, signal));
} else {
  cluster.worker.on("message", (message) => {
    cluster.worker.send({ echo: message.ping });
  });
  cluster.worker.send({ ready: true });
}
