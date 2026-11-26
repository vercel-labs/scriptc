// Two sends on a disconnected IPC channel queue one callback each on the
// next tick, so a program nextTick scheduled between the sends runs between
// the two callbacks (Node's nextTick FIFO), and the worker's exit event
// still follows both.
const cluster = require("cluster");

if (cluster.isPrimary) {
  const worker = cluster.fork();
  // Keeps the primary's loop alive until the worker's exit, so the
  // disconnect and exit events below are always delivered.
  const keepAlive = setTimeout(() => {}, 5000);
  worker.on("online", () => worker.send({ ping: 1 }));
  worker.on("message", (message) => {
    if (message.echo) worker.disconnect();
  });
  worker.on("disconnect", () => {
    worker.send({ first: 1 }, (error) => console.log("first callback", error && error.code));
    process.nextTick(() => console.log("user tick"));
    worker.send({ second: 1 }, (error) => console.log("second callback", error && error.code));
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
