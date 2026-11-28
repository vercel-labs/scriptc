// A cluster launch whose child cannot start reports Node's error on the
// worker instead of failing silently, and no 'exit' follows (the worker
// never had a process).
const cluster = require("cluster");

if (cluster.isPrimary) {
  cluster.setupPrimary({ cwd: "/nonexistent-scriptc-directory" });
  const worker = cluster.fork();
  worker.on("error", (error) => console.log("worker error", error.code));
  worker.on("exit", (code, signal) => console.log("worker exit", code, signal));
} else {
  console.log("worker started");
}
