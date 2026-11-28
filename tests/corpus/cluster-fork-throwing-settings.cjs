// cluster.fork runs setupPrimary before it starts a worker. A settings getter
// that throws during that merge makes the fork throw and no worker starts.
const cluster = require("cluster");

if (!cluster.isPrimary) {
  console.log("worker");
  process.exit(0);
}

cluster.on("setup", (settings) => console.log("setup", settings.silent));
cluster.setupPrimary({ silent: false });
Object.defineProperty(cluster.settings, "boom", {
  get() {
    throw new Error("merge boom");
  },
  enumerable: true,
  configurable: true,
});
try {
  cluster.fork();
  console.log("forked");
} catch (error) {
  console.log("threw", error.message);
}
setTimeout(() => process.exit(0), 300);
