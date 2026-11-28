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
  // The ping answers the worker's ready message, so the two messages the
  // primary logs have one order: sending on 'online' raced the worker's own
  // ready send (both messages then arrived in either order).
  worker.on("message", (message) => {
    console.log("primary message", JSON.stringify(message));
    if (message.ready) worker.send({ ping: 1 });
    if (message.echo) worker.disconnect();
  });
  // A failed send's callback and the child's exit are separate events, and
  // Node and a compiled program can deliver either first under load. Report
  // both once they have both arrived, in one fixed order.
  let lateCallback = null;
  let exitEvent = null;
  const reportLate = () => {
    if (lateCallback === null || exitEvent === null) return;
    console.log("late callback", lateCallback.code, lateCallback.message);
    console.log("exit", exitEvent.code, exitEvent.signal);
  };
  worker.on("disconnect", () => {
    const sent = worker.send({ late: 1 }, (error) => {
      lateCallback = { code: error && error.code, message: error && error.message };
      reportLate();
    });
    console.log("late send", sent, worker.isConnected());
  });
  worker.on("exit", (code, signal) => {
    clearTimeout(keepAlive);
    exitEvent = { code, signal };
    reportLate();
  });
} else {
  cluster.worker.on("message", (message) => {
    cluster.worker.send({ echo: message.ping });
  });
  cluster.worker.send({ ready: true });
}
