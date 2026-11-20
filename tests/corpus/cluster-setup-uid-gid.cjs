// setupPrimary's uid/gid reach the worker: it runs with those credentials.
// Only root can drop to another user, so a non-root run reports the skip.
const cluster = require("cluster");

if (cluster.isPrimary) {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    console.log("skip: not root");
  } else {
    cluster.setupPrimary({ uid: 65534, gid: 65534 });
    const worker = cluster.fork();
    worker.on("message", (message) => {
      console.log("worker credentials", message.uid, message.gid);
      worker.disconnect();
    });
    worker.on("exit", (code) => console.log("exit", code));
  }
} else {
  process.send({ uid: process.getuid(), gid: process.getgid() });
}
