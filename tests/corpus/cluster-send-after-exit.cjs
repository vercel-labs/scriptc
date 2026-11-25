// A send once the worker has exited answers false and calls its callback
// with ERR_IPC_CHANNEL_CLOSED; it never reports a success the channel did
// not carry.
const cluster = require("cluster");

if (cluster.isPrimary) {
  const worker = cluster.fork();
  worker.on("exit", (code) => {
    console.log("exit", code, "connected", worker.isConnected());
    const sent = worker.send({ late: 1 }, (error) => {
      console.log("send callback", error === null ? "null" : error.code);
    });
    console.log("send returned", sent);
  });
} else {
  process.exit(0);
}
