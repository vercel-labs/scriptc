// A send callback that runs while the primary services the old worker's
// channel forks a replacement worker. The replacement's channel must still
// be serviced — it answers, disconnects, and exits — so every channel
// closes and the primary's loop empties.
const cluster = require("cluster");

if (cluster.isPrimary) {
  const keepAlive = setTimeout(() => {}, 5000);
  const oldWorker = cluster.fork();
  let replacement = null;
  let oldDisconnected = false;
  let oldExited = false;
  let replied = false;
  let replacementDisconnected = false;
  let replacementExited = false;
  let done = false;
  const finish = () => {
    if (done) return;
    if (!(oldDisconnected && oldExited && replied && replacementDisconnected && replacementExited))
      return;
    done = true;
    clearTimeout(watchdog);
    clearTimeout(keepAlive);
    console.log("all channels closed");
  };
  const watchdog = setTimeout(() => {
    if (done) return;
    done = true;
    console.log("replacement timed out");
    if (replacement !== null) replacement.kill("SIGKILL");
    clearTimeout(keepAlive);
  }, 3000);
  // Sent while the channel is open; the old worker exits before reading it,
  // so this callback runs while the primary services the closing channel.
  oldWorker.send({ big: "x".repeat(2 * 1024 * 1024) }, () => {
    console.log("send callback");
    replacement = cluster.fork({ ROLE: "replacement" });
    replacement.on("online", () => replacement.send({ ping: 2 }));
    replacement.on("message", (message) => {
      replied = message.echo === 2;
      replacement.disconnect();
    });
    replacement.on("disconnect", () => {
      replacementDisconnected = true;
      finish();
    });
    replacement.on("exit", () => {
      replacementExited = true;
      finish();
    });
  });
  oldWorker.on("disconnect", () => {
    oldDisconnected = true;
    finish();
  });
  oldWorker.on("exit", () => {
    oldExited = true;
    finish();
  });
} else if (process.env.ROLE === "replacement") {
  cluster.worker.on("message", (message) => {
    cluster.worker.send({ echo: message.ping });
  });
} else {
  process.exit(0);
}
