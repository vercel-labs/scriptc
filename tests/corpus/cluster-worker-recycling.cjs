// Workers are recycled one at a time: each is gone from cluster.workers
// once it exits, and a long run of forks keeps the resident set flat
// instead of accumulating them.
const cluster = require("cluster");

if (cluster.isPrimary) {
  const total = 40;
  let recycled = 0;
  let pids = 0;
  const before = process.memoryUsage.rss();
  const next = () => {
    if (recycled === total) {
      console.log("recycled", recycled, "workers", Object.keys(cluster.workers).length);
      console.log("process pids", pids);
      console.log("growth-under-32mb", process.memoryUsage.rss() - before < 32 * 1024 * 1024);
      return;
    }
    recycled++;
    const worker = cluster.fork();
    // Reading worker.process boxes the child; the read must not outlive the
    // worker, so each completed child is reclaimed with it.
    if (typeof worker.process.pid === "number" && worker.process.pid > 0) pids++;
    worker.on("exit", () => next());
  };
  next();
} else {
  process.exit(0);
}
