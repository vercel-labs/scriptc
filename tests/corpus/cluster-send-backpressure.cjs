// A send larger than the channel's buffer returns false under
// backpressure but is still delivered, and its callback reports success
// (null), not a closed channel.
const cluster = require("cluster");

if (cluster.isPrimary) {
  const worker = cluster.fork();
  const big = "x".repeat(2 * 1024 * 1024);
  let delivered = null;
  let replied = null;
  const report = () => {
    if (delivered === null || replied === null) return;
    console.log("callback", delivered);
    console.log("reply", replied);
    worker.disconnect();
  };
  worker.on("online", () => {
    worker.send({ big }, (error) => {
      delivered = error === null ? "null" : error.code;
      report();
    });
  });
  worker.on("message", (message) => {
    replied = message.len;
    report();
  });
  worker.on("exit", (code) => console.log("exit", code));
} else {
  cluster.worker.on("message", (message) => {
    cluster.worker.send({ len: message.big.length });
  });
}
